#pragma once
#include <stdint.h>

// Completa estos datos locales. NO introduzcas aqui la clave de OpenAI.
static const char WIFI_SSID[] = "TU_WIFI_2_4_GHZ";
static const char WIFI_PASSWORD[] = "TU_CLAVE_WIFI";
static const char MQTT_HOST[] = "10.47.145.141";  // IPv4 de la laptop; nunca localhost
static const uint16_t MQTT_PORT = 1884;          // EMQX: normalmente 1884; broker integrado: 1883
static const char MQTT_USER[] = "oratoria";
static const char MQTT_PASSWORD[] = "CLAVE_MQTT_DEL_SERVIDOR";
// Conserva EXACTAMENTE el DEVICE_ID del .env o .env.emqx del servidor existente.
// El nombre anterior puede conservarse aunque ahora el hardware sea un ESP32-S3.
static const char DEVICE_ID[] = "esp32-oratoria";

static const int PIN_MIC_BCLK = 4;
static const int PIN_MIC_WS = 5;
static const int PIN_MIC_DATA = 6;
static const int MIC_GAIN = 1; // Ganancia digital entera. Prueba 2 o 4 si el nivel es bajo.
