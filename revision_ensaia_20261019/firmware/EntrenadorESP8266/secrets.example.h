#pragma once

// Editar SOLO secrets.h. Nunca pegar la clave de OpenAI en la placa.
static const char WIFI_SSID[] = "TU_WIFI_2_4_GHZ";
static const char WIFI_PASSWORD[] = "TU_CLAVE_WIFI";
static const char MQTT_HOST[] = "192.168.1.10"; // IPv4 de la laptop
static const uint16_t MQTT_PORT = 1883;
static const char MQTT_USER[] = "oratoria";
static const char MQTT_PASSWORD[] = "CLAVE_MQTT_GENERADA";
static const char DEVICE_ID[] = "esp8266-oratoria";
// No se presupone un LED conectado al ESP en esta placa combinada.
static const int STATUS_LED_GPIO = -1;
