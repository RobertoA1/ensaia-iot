/*
 * ENSAIA Cloud v1 | ESP32-S3 N16R8 + INMP441.
 * Arduino-ESP32 3.3.5; WebSockets (Markus Sattler) 2.7.2; ArduinoJson 6.21.5.
 * SCK=4, WS=5, SD=6, L/R=GND, VDD=3V3.
 * Conexion DIRECTA WSS a Vercel. No necesita MQTT, ESP8266 ni puente en laptop.
 * La clave OpenAI permanece en el servidor. Credenciales de usuario generadas en NVS.
 */
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <driver/i2s_std.h>
#include <esp_system.h>
#include <time.h>
#include "config.h"
#include "audio_format.h"
#include "trust.h"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif
#if !defined(CONFIG_IDF_TARGET_ESP32S3)
#error "Selecciona ESP32S3 Dev Module"
#endif

WebSocketsClient cloud;
Preferences preferences;
i2s_chan_handle_t microphone=nullptr;
SemaphoreHandle_t captureMutex;
QueueHandle_t audioQueue;
struct Frame{uint8_t bytes[ensaia_cloud::PACKET];};
bool captureEnabled=false,draining=false,authorized=false,cloudStarted=false;
uint32_t epoch=0,captured=0,sent=0,acknowledged=0,peak=0,otherPeak=0,reportedPeak=0;
volatile uint32_t dmaOverflows=0;
const char* captureError=nullptr;
char sid[17]="";
String username,password;
uint32_t startedAt=0,limitMs=180000,lastStatus=0,lastMeter=0,lastWifiTry=0;
String serialCommand;

bool sendJSON(JsonDocument& document){String text;serializeJson(document,text);return cloud.sendTXT(text);}
void credentials(){
  Serial.println("\n--- Acceso personal a ENSAIA ---");
  Serial.print("Web: https://");Serial.println(CLOUD_HOST);
  Serial.print("Usuario: ");Serial.println(username);
  Serial.print("Contrasena: ");Serial.println(password);
  Serial.println("Conserva estas credenciales en privado. La clave del dispositivo no se muestra.\n");
}
String randomPassword(){uint8_t data[16];esp_fill_random(data,sizeof(data));String result;result.reserve(32);for(uint8_t b:data){char h[3];snprintf(h,sizeof(h),"%02x",b);result+=h;}return result;}
void prepareCredentials(){
  preferences.begin("ensaia-cloud",false);
  username=preferences.getString("username","");password=preferences.getString("password","");
  if(!username.length()||!password.length()){
    if(strlen(PROPOSED_USER)&&strlen(PROPOSED_PASSWORD)>=16){username=PROPOSED_USER;password=PROPOSED_PASSWORD;}
    else{String mac=WiFi.macAddress();mac.replace(":","");mac.toLowerCase();username="ensaia_"+mac.substring(6);password=randomPassword();}
    preferences.putString("username",username);preferences.putString("password",password);
  }
  preferences.end();
}
bool validSid(const char* id){if(strlen(id)!=16)return false;for(int i=0;i<16;i++)if(!((id[i]>='0'&&id[i]<='9')||(id[i]>='a'&&id[i]<='f')))return false;return true;}
void haltCapture(const char* reason=nullptr){
  xSemaphoreTake(captureMutex,portMAX_DELAY);
  captureEnabled=false;++epoch;
  if(reason&&sid[0]&&!captureError)captureError=reason;
  xSemaphoreGive(captureMutex);
}
bool IRAM_ATTR onOverflow(i2s_chan_handle_t,i2s_event_data_t*,void*){++dmaOverflows;return false;}
void captureTask(void*){
  int32_t raw[ensaia_cloud::SAMPLES*2];Frame frame;uint32_t previousOverflows=dmaOverflows;
  for(;;){
    xSemaphoreTake(captureMutex,portMAX_DELAY);const uint32_t generation=epoch;xSemaphoreGive(captureMutex);
    size_t filled=0;esp_err_t result=ESP_OK;
    while(filled<sizeof(raw)){size_t n=0;result=i2s_channel_read(microphone,reinterpret_cast<uint8_t*>(raw)+filled,sizeof(raw)-filled,&n,100);filled+=n;if(result!=ESP_OK||!n)break;}
    if(result!=ESP_OK||filled!=sizeof(raw)){haltCapture("i2s_read_failed");vTaskDelay(pdMS_TO_TICKS(20));continue;}
    uint32_t framePeak=0,frameOtherPeak=0;
    for(unsigned i=0;i<ensaia_cloud::SAMPLES;i++){
      const int16_t value=ensaia_cloud::pcm16(raw[2*i],MIC_GAIN);const uint16_t bits=static_cast<uint16_t>(value);
      frame.bytes[24+2*i]=bits&255;frame.bytes[25+2*i]=bits>>8;
      const uint32_t magnitude=value<0?-static_cast<int32_t>(value):value;if(magnitude>framePeak)framePeak=magnitude;
      const int16_t other=ensaia_cloud::pcm16(raw[2*i+1],MIC_GAIN);
      const uint32_t otherMagnitude=other<0?-static_cast<int32_t>(other):other;
      if(otherMagnitude>frameOtherPeak)frameOtherPeak=otherMagnitude;
    }
    xSemaphoreTake(captureMutex,portMAX_DELAY);
    peak=max(peak,framePeak);otherPeak=max(otherPeak,frameOtherPeak);
    if(captureEnabled&&generation==epoch){
      if(previousOverflows!=dmaOverflows){captureEnabled=false;captureError="i2s_dma_overflow";}
      else{ensaia_cloud::header(frame.bytes,sid,captured);if(xQueueSend(audioQueue,&frame,0)==pdTRUE)++captured;else{captureEnabled=false;captureError="audio_queue_full";}}
    }
    previousOverflows=dmaOverflows;
    xSemaphoreGive(captureMutex);
  }
}
void notifyError(const char* reason){
  if(!authorized)return;
  StaticJsonDocument<256> doc;doc["type"]="capture.error";doc["sid"]=sid;doc["reason"]=reason;sendJSON(doc);
}
void event(WStype_t type,uint8_t* payload,size_t length){
  if(type==WStype_CONNECTED){
    authorized=false;
    StaticJsonDocument<1024> auth;auth["type"]="device.auth";auth["deviceId"]=DEVICE_ID;auth["secret"]=DEVICE_SECRET;auth["username"]=username;auth["password"]=password;
    sendJSON(auth);Serial.println("Servidor conectado. Verificando el dispositivo...");return;
  }
  if(type==WStype_DISCONNECTED){
    haltCapture();authorized=false;draining=false;xQueueReset(audioQueue);sid[0]=0;
    Serial.println("Conexion cerrada. Reintentando; una toma interrumpida no se reanuda.");return;
  }
  if(type!=WStype_TEXT||length>3072)return;
  StaticJsonDocument<4096> doc;
  if(deserializeJson(doc,reinterpret_cast<const char*>(payload),length))return;
  const char* kind=doc["type"]|"";
  if(!strcmp(kind,"auth.ok")){authorized=true;Serial.println("DISPOSITIVO AUTORIZADO. Abre la web para iniciar una presentacion.");credentials();}
  else if(!strcmp(kind,"auth.error")){Serial.print("REGISTRO RECHAZADO: ");Serial.println(doc["message"]|"Revisa la configuracion");authorized=false;}
  else if(!strcmp(kind,"capture.start")&&authorized){
    const char* id=doc["sid"]|"";
    if(!validSid(id)||(doc["sampleRate"]|0)!=16000||(doc["samplesPerFrame"]|0)!=320){notifyError("unsupported_audio_format");return;}
    xSemaphoreTake(captureMutex,portMAX_DELAY);
    if(captureEnabled||draining){xSemaphoreGive(captureMutex);notifyError("capture_already_running");return;}
    xQueueReset(audioQueue);strcpy(sid,id);captured=0;sent=0;acknowledged=0;captureError=nullptr;++epoch;captureEnabled=true;
    xSemaphoreGive(captureMutex);
    const uint32_t seconds=doc["maxSeconds"]|180;limitMs=min(seconds,static_cast<uint32_t>(180))*1000;startedAt=millis();
    StaticJsonDocument<160> reply;reply["type"]="capture.started";reply["sid"]=sid;sendJSON(reply);
    Serial.printf("[GRABANDO] %s. Control desde la web.\n",sid);
  }else if(!strcmp(kind,"capture.stop")&&authorized&&!strcmp(doc["sid"]|"",sid)){haltCapture();draining=true;}
  else if(!strcmp(kind,"audio.ack")&&!strcmp(doc["sid"]|"",sid)){acknowledged=doc["frames"]|acknowledged;}
  else if(!strcmp(kind,"feedback")){Serial.print("[CONSEJO IA] ");Serial.println(doc["text"]|"");}
  else if(!strcmp(kind,"session.ended")){Serial.println("[GUARDADO] Consulta el resumen y las estadisticas en la web.");sid[0]=0;}
  else if(!strcmp(kind,"reconnect")){cloud.disconnect();}
  else if(!strcmp(kind,"error")){Serial.print("[SERVIDOR] ");Serial.println(doc["message"]|"");}
}
void setup(){
  Serial.begin(115200);delay(700);
  Serial.println("\nENSAIA Cloud | ESP32-S3 + INMP441 | v1");
  Serial.printf("Flash: %u MB | PSRAM: %u MB\n",ESP.getFlashChipSize()/1048576,ESP.getPsramSize()/1048576);
  captureMutex=xSemaphoreCreateMutex();audioQueue=xQueueCreate(100,sizeof(Frame));
  if(!captureMutex||!audioQueue){Serial.println("ERROR: memoria insuficiente");while(true)delay(1000);}
  i2s_chan_config_t channel=I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO,I2S_ROLE_MASTER);channel.dma_desc_num=8;channel.dma_frame_num=320;
  ESP_ERROR_CHECK(i2s_new_channel(&channel,nullptr,&microphone));
  i2s_std_config_t config={};config.clk_cfg=I2S_STD_CLK_DEFAULT_CONFIG(16000);
  config.slot_cfg=I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT,I2S_SLOT_MODE_STEREO);
  config.gpio_cfg.mclk=I2S_GPIO_UNUSED;config.gpio_cfg.bclk=static_cast<gpio_num_t>(MIC_BCLK);config.gpio_cfg.ws=static_cast<gpio_num_t>(MIC_WS);
  config.gpio_cfg.dout=I2S_GPIO_UNUSED;config.gpio_cfg.din=static_cast<gpio_num_t>(MIC_DATA);
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(microphone,&config));
  i2s_event_callbacks_t cb={};cb.on_recv_q_ovf=onOverflow;
  ESP_ERROR_CHECK(i2s_channel_register_event_callback(microphone,&cb,nullptr));ESP_ERROR_CHECK(i2s_channel_enable(microphone));
  if(xTaskCreatePinnedToCore(captureTask,"microfono",6144,nullptr,2,nullptr,1)!=pdPASS){Serial.println("ERROR: no se pudo iniciar microfono");while(true)delay(1000);}
  WiFi.mode(WIFI_STA);WiFi.setSleep(false);prepareCredentials();WiFi.begin(WIFI_SSID,WIFI_PASSWORD);
  configTime(0,0,"pool.ntp.org","time.google.com");
  cloud.onEvent(event);cloud.setReconnectInterval(3000);cloud.enableHeartbeat(15000,3000,2);
  Serial.println("Esperando Wi-Fi y sincronizacion de hora para verificar TLS.");
  Serial.println("El medidor local no transmite audio. La grabacion empieza desde la web.");
}
void loop(){
  const uint32_t now=millis();
  while(Serial.available()){
    const char c=Serial.read();if(c=='\n'||c=='\r'){if(serialCommand=="credenciales")credentials();serialCommand="";}
    else if(serialCommand.length()<32)serialCommand+=c;
  }
  if(now-lastMeter>=1000){
    lastMeter=now;xSemaphoreTake(captureMutex,portMAX_DELAY);
    const uint32_t level=peak,otherLevel=otherPeak;peak=0;otherPeak=0;xSemaphoreGive(captureMutex);
    reportedPeak=level;
    Serial.printf("[MIC] Izq=%lu/32768 | Der=%lu/32768 | WiFi=%s | Web=%s\n",
      (unsigned long)level,(unsigned long)otherLevel,WiFi.isConnected()?"SI":"NO",authorized?"SI":"NO");
  }
  if(!WiFi.isConnected()){
    if(captureEnabled)haltCapture("wifi_disconnected");
    if(now-lastWifiTry>10000){lastWifiTry=now;WiFi.reconnect();}
    delay(2);return;
  }
  if(!cloudStarted&&time(nullptr)>1700000000){
    cloud.beginSslWithCA(CLOUD_HOST,443,"/api/server?role=device",CLOUD_ROOT_CA,"arduino");cloudStarted=true;
  }
  if(cloudStarted)cloud.loop();
  if(!authorized){delay(2);return;}
  // cloud.loop() puede iniciar la captura después de calcular `now`.
  // Leer millis() de nuevo evita que la resta sin signo se desborde al empezar.
  if(captureEnabled&&millis()-startedAt>=limitMs){haltCapture();draining=true;}
  Frame frame;
  for(int i=0;i<4&&authorized;i++){
    if(xQueueReceive(audioQueue,&frame,0)!=pdTRUE)break;
    if(cloud.sendBIN(frame.bytes,sizeof(frame.bytes)))++sent;else{haltCapture("websocket_send_failed");break;}
    cloud.loop();
  }
  if(captureEnabled&&sent>acknowledged+100)haltCapture("server_ack_timeout");
  xSemaphoreTake(captureMutex,portMAX_DELAY);const char* error=captureError;captureError=nullptr;const uint32_t total=captured;xSemaphoreGive(captureMutex);
  if(error){notifyError(error);Serial.print("[CAPTURA INTERRUMPIDA] ");Serial.println(error);xQueueReset(audioQueue);draining=false;}
  if(draining&&!uxQueueMessagesWaiting(audioQueue)){
    StaticJsonDocument<256> done;done["type"]="capture.ended";done["sid"]=sid;done["frames"]=total;done["reason"]="user";sendJSON(done);draining=false;
    Serial.printf("[CAPTURA FINALIZADA] %lu tramas. Esperando informe...\n",(unsigned long)total);
  }
  if(now-lastStatus>=2000){
    lastStatus=now;StaticJsonDocument<256> status;status["type"]="device.status";status["rssi"]=WiFi.RSSI();status["peak"]=reportedPeak;status["freeHeap"]=ESP.getFreeHeap();status["firmware"]="ensaia-cloud-s3-v1";sendJSON(status);
  }
  delay(1);
}
