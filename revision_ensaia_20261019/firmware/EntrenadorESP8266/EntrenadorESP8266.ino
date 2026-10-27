/*
 * RobotDyn UNO+WiFi R3: este sketch se carga al ESP8266, NO al ATmega328P.
 * Arduino core ESP8266 3.1.2; PubSubClient 2.8; ArduinoJson 6.21.5.
 *
 * Celular HTTPS -> laptop/broker -> down/audio -> ESP -> up/audio -> pasarela GPT-Live.
 * GPT-Live -> down/event -> ESP -> up/event -> persistencia y feedback en celular.
 * El ESP imprime feedback por Serial a 115200. No hay altavoz/DAC en este montaje.
 * No conecta directamente con OpenAI: la pasarela mantiene TLS y la API key.
 */
#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

// PubSubClient detecta una escritura corta, pero no cierra el flujo TCP.
// Seguir enviando haria que el broker lea otra cabecera como parte del payload.
class CheckedWiFiClient : public WiFiClient {
 public:
  uint32_t shortWrites = 0;
  using WiFiClient::write;
  size_t write(uint8_t value) override { return write(&value, 1); }
  size_t write(const uint8_t* data, size_t length) override {
    const size_t sent = WiFiClient::write(data, length);
    if (sent != length) {
      shortWrites++;
      WiFiClient::stop();
    }
    return sent;
  }
};
CheckedWiFiClient network;
PubSubClient mqtt(network);
StaticJsonDocument<2048> document;
static uint8_t copyBuffer[1801];
static char activeSession[9] = "";
static char seen[16][33] = {};
static uint8_t seenPosition = 0;
static bool feedbackEnabled = true;
static uint32_t forwardedFrames = 0, failedPublishes = 0;
static uint32_t lastMqttAttempt = 0, lastWifiAttempt = 0, lastHeartbeat = 0;
String root, downControl, downAudio, downEvent, upControl, upAudio, upEvent, upStatus;

bool validSession(const char* sid) {
  if (!sid || strlen(sid) != 8) return false;
  for (uint8_t i = 0; i < 8; i++)
    if (!((sid[i] >= '0' && sid[i] <= '9') || (sid[i] >= 'a' && sid[i] <= 'f'))) return false;
  return true;
}

bool alreadySeen(const char* id) {
  for (uint8_t i = 0; i < 16; i++) if (strcmp(seen[i], id) == 0) return true;
  strncpy(seen[seenPosition], id, 32);
  seen[seenPosition][32] = '\0';
  seenPosition = (seenPosition + 1) % 16;
  return false;
}

bool sendCopied(const String& destination, unsigned int length) {
  bool ok = mqtt.publish(destination.c_str(), copyBuffer, length, false);
  if (!ok) failedPublishes++;
  return ok;
}

void receive(char* topic, uint8_t* payload, unsigned int length) {
  // PubSubClient reutiliza el buffer al publicar. Copiar ANTES de publicar desde el callback.
  if (length > 1800) return;
  const bool audio = strcmp(topic, downAudio.c_str()) == 0;
  const bool control = strcmp(topic, downControl.c_str()) == 0;
  const bool event = strcmp(topic, downEvent.c_str()) == 0;
  memcpy(copyBuffer, payload, length);
  copyBuffer[length] = 0;

  if (audio) {
    // Cabecera: SID ASCII[8] + secuencia uint32 LE + offset de muestras uint32 LE.
    // PCM16 LE mono, 16000 Hz, hasta 320 muestras por trama (20 ms).
    if (length <= 16 || length > 656 || ((length - 16) % 2) != 0) return;
    if (!activeSession[0] || memcmp(copyBuffer, activeSession, 8) != 0) return;
    if (sendCopied(upAudio, length)) forwardedFrames++;
    return;
  }

  if (!control && !event) return;
  document.clear();
  // Entrada const: ArduinoJson no debe modificar el JSON que se devolvera byte a byte.
  if (deserializeJson(document, reinterpret_cast<const char*>(copyBuffer), length)) return;
  const char* sid = document["sid"] | "";
  const char* id = document["id"] | "";
  if (!validSession(sid) || strlen(id) != 32) return;

  if (control) {
    const char* operation = document["op"] | "";
    if (strcmp(operation, "start") == 0) {
      // Una reentrega de start no reinicia contadores de una sesion ya activa.
      if (strcmp(activeSession, sid) != 0) {
        strncpy(activeSession, sid, sizeof(activeSession));
        forwardedFrames = 0;
        failedPublishes = 0;
      }
      feedbackEnabled = document["feedback"] | true;
      sendCopied(upControl, length);
      Serial.printf("\n[SESION %s] Iniciada. Feedback: %s\n", activeSession, feedbackEnabled ? "SI" : "NO");
    } else if (strcmp(operation, "stop") == 0) {
      sendCopied(upControl, length);
      if (strcmp(activeSession, sid) == 0) {
        Serial.printf("\n[SESION %s] Finalizada. Tramas: %lu; fallos: %lu\n", activeSession,
                      static_cast<unsigned long>(forwardedFrames), static_cast<unsigned long>(failedPublishes));
        activeSession[0] = '\0';
      }
    }
    return;
  }

  // El eco es la confirmacion de aplicacion: la laptop conserva y reintenta registros no confirmados.
  // Tambien se entregan eventos pendientes de sesiones anteriores, sin mostrarlos como consejos actuales.
  sendCopied(upEvent, length);
  const bool duplicate = alreadySeen(id);
  const char* kind = document["kind"] | "";
  if (!duplicate && strcmp(activeSession, sid) == 0 && feedbackEnabled &&
      strcmp(kind, "feedback.ai") == 0 && (document["visible"] | false)) {
    const char* text = document["text"] | "";
    Serial.print("[CONSEJO IA] ");
    Serial.println(text);
    if (STATUS_LED_GPIO >= 0) digitalWrite(STATUS_LED_GPIO, !digitalRead(STATUS_LED_GPIO));
  }
}

void heartbeat() {
  StaticJsonDocument<384> status;
  status["online"] = true;
  status["simulated"] = false;
  status["sid"] = activeSession;
  status["uptime_ms"] = millis();
  status["free_heap"] = ESP.getFreeHeap();
  status["firmware"] = "relay-q0-v3";
  status["short_writes"] = network.shortWrites;
  status["frames_forwarded"] = forwardedFrames;
  status["failed_publishes"] = failedPublishes;
  char output[384];
  size_t length = serializeJson(status, output, sizeof(output));
  mqtt.publish(upStatus.c_str(), reinterpret_cast<const uint8_t*>(output), length, true);
}

void setup() {
  Serial.begin(115200);
  Serial.println("\nEntrenador IoT - nodo ESP8266 RobotDyn");
  Serial.println("Firmware: relay-q0-v3; TCP con deteccion de escrituras incompletas");
  Serial.printf("Flash detectada: %lu bytes; heap: %lu bytes\n",
                static_cast<unsigned long>(ESP.getFlashChipRealSize()),
                static_cast<unsigned long>(ESP.getFreeHeap()));
  root = String("oratoria/v1/") + DEVICE_ID;
  downControl = root + "/down/control"; downAudio = root + "/down/audio"; downEvent = root + "/down/event";
  upControl = root + "/up/control"; upAudio = root + "/up/audio"; upEvent = root + "/up/event"; upStatus = root + "/up/status";
  if (STATUS_LED_GPIO >= 0) { pinMode(STATUS_LED_GPIO, OUTPUT); digitalWrite(STATUS_LED_GPIO, LOW); }
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(receive);
  mqtt.setBufferSize(2048);
  mqtt.setKeepAlive(10);
  mqtt.setSocketTimeout(2);
  lastMqttAttempt = millis() - 3000;
}

void loop() {
  const uint32_t now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiAttempt >= 10000) {
      lastWifiAttempt = now;
      WiFi.reconnect();
      Serial.println("Esperando Wi-Fi 2.4 GHz...");
    }
    delay(1);
    return;
  }
  if (!mqtt.connected()) {
    if (now - lastMqttAttempt >= 3000) {
      lastMqttAttempt = now;
      const char* will = "{\"online\":false,\"simulated\":false}";
      if (mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD, upStatus.c_str(), 1, true, will)) {
        network.setNoDelay(true);
        mqtt.subscribe(downControl.c_str(), 0);
        mqtt.subscribe(downAudio.c_str(), 0);
        mqtt.subscribe(downEvent.c_str(), 0);
        Serial.print("MQTT conectado. IP de la placa: "); Serial.println(WiFi.localIP());
        heartbeat();
      } else {
        Serial.printf("MQTT no disponible, estado %d. Reintentando...\n", mqtt.state());
      }
    }
    delay(1);
    return;
  }
  const uint32_t previousShortWrites = network.shortWrites;
  mqtt.loop();
  if (network.shortWrites != previousShortWrites) {
    Serial.printf("[TRANSPORTE] Escritura TCP incompleta; conexion cerrada. Total: %lu; RAM: %lu\n",
                  static_cast<unsigned long>(network.shortWrites),
                  static_cast<unsigned long>(ESP.getFreeHeap()));
  }
  if (now - lastHeartbeat >= 2000) { lastHeartbeat = now; heartbeat(); }
  delay(0); // atiende Wi-Fi y watchdog sin esperas largas
}
