/*
 * ENSAIA - ESP32-S3 N16R8 + INMP441 (L/R -> GND).
 * Arduino-ESP32 3.3.5, PubSubClient 2.8, ArduinoJson 6.21.5.
 * BCLK=4, WS=5, SD=6. PCM16 LE mono 16000 Hz; 320 muestras/20 ms.
 * Captura real + relevo MQTT compatible con ENSAIA. La IA sigue en la laptop.
 * Arranca SIN transmitir microfono. El puente de laptop inicia/finaliza sesiones.
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <driver/i2s_std.h>
#include <esp_heap_caps.h>
#include "config.h"
#include "audio_format.h"

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
#error "Selecciona ESP32S3 Dev Module. Este programa es para ESP32-S3."
#endif

class CheckedClient : public WiFiClient {
 public:
  uint32_t shortWrites = 0;
  using WiFiClient::write;
  size_t write(uint8_t b) override { return write(&b, 1); }
  size_t write(const uint8_t* p, size_t n) override {
    const size_t written = WiFiClient::write(p, n);
    if (written != n) { ++shortWrites; WiFiClient::stop(); }
    return written;
  }
};

CheckedClient network;
PubSubClient mqtt(network);
i2s_chan_handle_t mic = nullptr;
QueueHandle_t audioQueue;
SemaphoreHandle_t captureMutex;
struct AudioPacket { uint8_t bytes[ensaia::PACKET_BYTES]; };
static_assert(sizeof(AudioPacket) == 656, "Formato incorrecto");
// Protegidos con captureMutex. Solo loop() accede a MQTT/Serial.
bool capturing = false;
uint32_t generation = 0, capturedFrames = 0;
char captureSid[9] = "";
const char* captureFault = nullptr;
uint32_t micPeak = 0, clippedSamples = 0;
volatile uint32_t dmaOverflows = 0;
uint32_t sentFrames = 0, forwardedFrames = 0, failedPublishes = 0;
char activeSession[9] = "";
char seen[32][33] = {};
uint8_t seenAt = 0;
bool feedbackEnabled = false, showMeter = true;
bool stoppingMic = false;
uint32_t stopDeadline = 0;
char stopId[33] = "", lastStopId[33] = "", lastStopSid[9] = "";
uint32_t lastStopFrames = 0;
String root, downControl, downAudio, downEvent, upControl, upAudio, upEvent, upStatus;
String micControl, micAck, micAudio;
static uint8_t messageCopy[1801];
StaticJsonDocument<3072> message;
uint32_t lastMqttTry = 0, lastWifiTry = 0, lastHeartbeat = 0, lastMeter = 0;

bool validSid(const char* sid) {
  if (!sid || strlen(sid) != 8) return false;
  for (int i = 0; i < 8; ++i)
    if (!((sid[i] >= '0' && sid[i] <= '9') || (sid[i] >= 'a' && sid[i] <= 'f'))) return false;
  return true;
}
bool publish(const String& topic, const uint8_t* data, size_t n, bool retain = false) {
  const bool ok = mqtt.publish(topic.c_str(), data, n, retain);
  if (!ok) ++failedPublishes;
  return ok;
}
void fault(const char* reason) {
  xSemaphoreTake(captureMutex, portMAX_DELAY);
  if (capturing || stoppingMic) {
    capturing = false;
    ++generation;
    if (!captureFault) captureFault = reason;
  }
  xSemaphoreGive(captureMutex);
}
bool IRAM_ATTR overflow(i2s_chan_handle_t, i2s_event_data_t*, void*) {
  ++dmaOverflows;
  return false;
}

void captureTask(void*) {
  int32_t raw[ensaia::SAMPLES * 2];
  AudioPacket packet;
  uint32_t previousOverflows = dmaOverflows;
  for (;;) {
    xSemaphoreTake(captureMutex, portMAX_DELAY);
    const uint32_t epoch = generation;
    xSemaphoreGive(captureMutex);
    size_t filled = 0;
    esp_err_t result = ESP_OK;
    while (filled < sizeof(raw)) {
      size_t count = 0;
      result = i2s_channel_read(mic, reinterpret_cast<uint8_t*>(raw) + filled,
                                sizeof(raw) - filled, &count, 100);
      filled += count;
      if (result != ESP_OK || count == 0) break;
    }
    if (result != ESP_OK || filled != sizeof(raw)) {
      fault("i2s_read_failed");
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    uint32_t peak = 0, clips = 0;
    for (unsigned i = 0; i < ensaia::SAMPLES; ++i) {
      // Se capturan AMBAS ranuras de 32 bits (64 BCLK por muestra); solo se usa izquierda.
      const int16_t value = ensaia::pcm16(raw[2 * i], MIC_GAIN);
      const uint32_t magnitude = value < 0 ? -static_cast<int32_t>(value) : value;
      if (magnitude > peak) peak = magnitude;
      if (value == 32767 || value == -32768) ++clips;
      ensaia::sample(packet.bytes + 16 + 2 * i, value);
    }
    xSemaphoreTake(captureMutex, portMAX_DELAY);
    micPeak = max(micPeak, peak);
    clippedSamples += clips;
    if (capturing && generation == epoch) {
      if (dmaOverflows != previousOverflows) {
        capturing = false;
        captureFault = "i2s_dma_overflow";
      } else {
        ensaia::header(packet.bytes, captureSid, capturedFrames);
        if (xQueueSend(audioQueue, &packet, 0) == pdTRUE) ++capturedFrames;
        else { capturing = false; captureFault = "audio_queue_full"; }
      }
    }
    previousOverflows = dmaOverflows;
    xSemaphoreGive(captureMutex);
  }
}

void acknowledge(const char* id, const char* sid, const char* op, uint32_t frames,
                 const char* error = nullptr) {
  StaticJsonDocument<384> ack;
  ack["id"] = id; ack["sid"] = sid; ack["op"] = op;
  ack["frames"] = frames; ack["ok"] = (error == nullptr);
  if (error) ack["error"] = error;
  char out[384];
  const size_t n = serializeJson(ack, out, sizeof(out));
  publish(micAck, reinterpret_cast<uint8_t*>(out), n);
}

void receive(char* topic, uint8_t* payload, unsigned int length) {
  if (length > 1800) return;
  memcpy(messageCopy, payload, length); messageCopy[length] = 0;
  if (strcmp(topic, downAudio.c_str()) == 0) {
    if (length <= 16 || length > 656 || (length - 16) % 2 ||
        !activeSession[0] || memcmp(messageCopy, activeSession, 8)) return;
    if (publish(upAudio, messageCopy, length)) ++forwardedFrames;
    else fault("relay_publish_failed");
    return;
  }
  message.clear();
  if (deserializeJson(message, reinterpret_cast<const char*>(messageCopy), length)) return;
  const char* sid = message["sid"] | "";
  const char* id = message["id"] | "";
  const char* op = message["op"] | "";
  if (!validSid(sid) || strlen(id) != 32) return;

  if (strcmp(topic, micControl.c_str()) == 0) {
    if (strcmp(op, "mic_start") == 0) {
      if (strcmp(activeSession, sid) != 0 || stoppingMic) {
        acknowledge(id, sid, op, 0, "session_not_ready"); return;
      }
      xSemaphoreTake(captureMutex, portMAX_DELAY);
      // Reintentar el mismo inicio no reinicia la secuencia. Tras fallo no se reanuda.
      const bool duplicate = strcmp(captureSid, sid) == 0;
      const bool canStart = !duplicate && !capturing;
      if (canStart) {
        xQueueReset(audioQueue);
        strcpy(captureSid, sid); ++generation;
        capturedFrames = 0; sentFrames = 0; captureFault = nullptr;
        capturing = true;
      }
      const bool okay = capturing && !captureFault;
      const uint32_t frames = capturedFrames;
      xSemaphoreGive(captureMutex);
      acknowledge(id, sid, op, frames, okay ? nullptr : "capture_not_available");
      if (canStart) Serial.printf("[GRABANDO] Sesion %s\n", sid);
    } else if (strcmp(op, "mic_stop") == 0) {
      if (strcmp(lastStopId, id) == 0 && strcmp(lastStopSid, sid) == 0) {
        acknowledge(id, sid, op, lastStopFrames); return;
      }
      xSemaphoreTake(captureMutex, portMAX_DELAY);
      const bool matches = strcmp(captureSid, sid) == 0;
      if (matches) { capturing = false; ++generation; }
      xSemaphoreGive(captureMutex);
      if (!matches) { acknowledge(id, sid, op, 0, "wrong_session"); return; }
      if (!stoppingMic) {
        strcpy(stopId, id); stoppingMic = true; stopDeadline = millis() + 5000;
      }
    }
    return;
  }
  if (strcmp(topic, downControl.c_str()) == 0) {
    if (strcmp(op, "start") == 0) {
      if (strcmp(activeSession, sid) != 0) {
        fault("session_changed");
        strcpy(activeSession, sid); forwardedFrames = 0; failedPublishes = 0;
      }
      feedbackEnabled = message["feedback"] | false;
      publish(upControl, messageCopy, length);
    } else if (strcmp(op, "stop") == 0) {
      if (strcmp(activeSession, sid) == 0) {
        xSemaphoreTake(captureMutex, portMAX_DELAY);
        capturing = false; ++generation;
        xSemaphoreGive(captureMutex);
        activeSession[0] = 0;
        Serial.println("[SESION] Finalizada por servidor.");
      }
      publish(upControl, messageCopy, length);
    }
    return;
  }
  if (strcmp(topic, downEvent.c_str()) != 0) return;
  publish(upEvent, messageCopy, length); // Eco EXACTO: confirma outbox del servidor.
  bool duplicate = false;
  for (unsigned i = 0; i < 32; ++i) if (!strcmp(seen[i], id)) duplicate = true;
  if (duplicate) return;
  strcpy(seen[seenAt], id); seenAt = (seenAt + 1) % 32;
  const char* kind = message["kind"] | "";
  if (!strcmp(sid, activeSession) && feedbackEnabled && !strcmp(kind, "feedback.ai") &&
      (message["visible"] | false)) {
    Serial.print("[CONSEJO IA] "); Serial.println(message["text"] | "");
  } else if (!strcmp(kind, "transcript.user")) {
    Serial.print("[TEXTO] "); Serial.println(message["text"] | "");
  }
}

void heartbeat() {
  StaticJsonDocument<768> status;
  status["online"] = true; status["simulated"] = false;
  status["sid"] = activeSession; status["firmware"] = "ensaia-s3-i2s-v1";
  status["hardware"] = "ESP32-S3-INMP441";
  status["uptime_ms"] = millis(); status["free_heap"] = ESP.getFreeHeap();
  status["largest_free_block"] = heap_caps_get_largest_free_block(MALLOC_CAP_8BIT);
  status["psram_bytes"] = ESP.getPsramSize(); status["wifi_rssi"] = WiFi.RSSI();
  status["short_writes"] = network.shortWrites;
  status["frames_forwarded"] = forwardedFrames; status["failed_publishes"] = failedPublishes;
  status["mic_frames_sent"] = sentFrames;
  status["i2s_dma_overflows"] = dmaOverflows;
  xSemaphoreTake(captureMutex, portMAX_DELAY);
  status["mic_capturing"] = capturing;
  status["mic_frames_captured"] = capturedFrames;
  xSemaphoreGive(captureMutex);
  char out[768]; const size_t n = serializeJson(status, out, sizeof(out));
  publish(upStatus, reinterpret_cast<uint8_t*>(out), n, true);
}

void setup() {
  Serial.begin(115200);
  delay(700);
  Serial.println("\nENSAIA | ESP32-S3 + INMP441 | v1");
  Serial.printf("Flash: %u MB | PSRAM: %u MB\n", ESP.getFlashChipSize() / 1048576,
                ESP.getPsramSize() / 1048576);
  captureMutex = xSemaphoreCreateMutex();
  audioQueue = xQueueCreate(100, sizeof(AudioPacket)); // 2 s; NO una grabacion completa.
  if (!captureMutex || !audioQueue) { Serial.println("ERROR: RAM insuficiente"); while (true) delay(1000); }
  i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
  channel.dma_desc_num = 8; channel.dma_frame_num = 320;
  ESP_ERROR_CHECK(i2s_new_channel(&channel, nullptr, &mic));
  i2s_std_config_t config = {};
  config.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(ensaia::RATE);
  config.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO);
  config.gpio_cfg.mclk = I2S_GPIO_UNUSED;
  config.gpio_cfg.bclk = static_cast<gpio_num_t>(PIN_MIC_BCLK);
  config.gpio_cfg.ws = static_cast<gpio_num_t>(PIN_MIC_WS);
  config.gpio_cfg.dout = I2S_GPIO_UNUSED;
  config.gpio_cfg.din = static_cast<gpio_num_t>(PIN_MIC_DATA);
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(mic, &config));
  i2s_event_callbacks_t callbacks = {}; callbacks.on_recv_q_ovf = overflow;
  ESP_ERROR_CHECK(i2s_channel_register_event_callback(mic, &callbacks, nullptr));
  ESP_ERROR_CHECK(i2s_channel_enable(mic));
  if (xTaskCreatePinnedToCore(captureTask, "microfono", 6144, nullptr, 2, nullptr, 1) != pdPASS) {
    Serial.println("ERROR: no se pudo iniciar captura"); while (true) delay(1000);
  }
  Serial.println("I2S preparado. Habla: el valor pico debe cambiar. 'm' activa/desactiva el medidor.");
  root = String("oratoria/v1/") + DEVICE_ID;
  downControl = root + "/down/control"; downAudio = root + "/down/audio";
  downEvent = root + "/down/event"; upControl = root + "/up/control";
  upAudio = root + "/up/audio"; upEvent = root + "/up/event"; upStatus = root + "/up/status";
  micControl = root + "/down/mic_control"; micAck = root + "/up/mic_control";
  micAudio = root + "/up/mic_audio";
  WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  mqtt.setServer(MQTT_HOST, MQTT_PORT); mqtt.setCallback(receive);
  mqtt.setBufferSize(3072); mqtt.setKeepAlive(10); mqtt.setSocketTimeout(1);
  lastMqttTry = millis() - 3000;
}

void loop() {
  const uint32_t now = millis();
  if (Serial.available() && Serial.read() == 'm') showMeter = !showMeter;
  if (showMeter && now - lastMeter >= 1000) {
    lastMeter = now;
    xSemaphoreTake(captureMutex, portMAX_DELAY);
    const uint32_t peak = micPeak, clips = clippedSamples;
    micPeak = 0; clippedSamples = 0;
    xSemaphoreGive(captureMutex);
    Serial.printf("[MIC] Pico=%lu/32768 | saturadas=%lu | WiFi=%s\n",
                  (unsigned long)peak, (unsigned long)clips, WiFi.isConnected() ? "SI" : "NO");
  }
  if (WiFi.status() != WL_CONNECTED) {
    fault("wifi_disconnected");
    if (now - lastWifiTry >= 10000) { lastWifiTry = now; WiFi.reconnect(); }
    delay(2); return;
  }
  if (!mqtt.connected()) {
    fault("mqtt_disconnected");
    if (now - lastMqttTry >= 3000) {
      lastMqttTry = now;
      if (mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASSWORD, upStatus.c_str(), 1, true,
                       "{\"online\":false,\"simulated\":false}")) {
        network.setNoDelay(true);
        mqtt.subscribe(downControl.c_str(), 0); mqtt.subscribe(downAudio.c_str(), 0);
        mqtt.subscribe(downEvent.c_str(), 0); mqtt.subscribe(micControl.c_str(), 0);
        Serial.print("MQTT conectado. IP ESP32: "); Serial.println(WiFi.localIP());
        heartbeat();
      } else Serial.printf("MQTT no disponible: %d\n", mqtt.state());
    }
    delay(2); return;
  }
  mqtt.loop();
  AudioPacket packet;
  // Limitar rafaga para atender tambien feedback/control del servidor.
  for (int i = 0; i < 4 && mqtt.connected(); ++i) {
    if (xQueueReceive(audioQueue, &packet, 0) != pdTRUE) break;
    if (publish(micAudio, packet.bytes, sizeof(packet.bytes))) ++sentFrames;
    else { fault("mic_publish_failed"); break; }
    mqtt.loop();
  }
  xSemaphoreTake(captureMutex, portMAX_DELAY);
  const char* error = captureFault;
  captureFault = nullptr;
  const uint32_t frames = capturedFrames;
  xSemaphoreGive(captureMutex);
  if (error) {
    acknowledge("", captureSid, "mic_error", sentFrames, error);
    Serial.printf("[ERROR MICROFONO] %s. Inicia otra sesion; no se reanuda audio perdido.\n", error);
    xQueueReset(audioQueue);
    stoppingMic = false;
  }
  if (stoppingMic) {
    if (!uxQueueMessagesWaiting(audioQueue)) {
      strcpy(lastStopId, stopId); strcpy(lastStopSid, captureSid); lastStopFrames = frames;
      acknowledge(stopId, captureSid, "mic_stop", frames);
      stoppingMic = false;
      Serial.printf("[MIC] Detenido. Tramas enviadas: %lu\n", (unsigned long)sentFrames);
    } else if (static_cast<int32_t>(millis() - stopDeadline) >= 0) fault("stop_drain_timeout");
  }
  if (now - lastHeartbeat >= 2000) { lastHeartbeat = now; heartbeat(); }
  delay(1);
}
