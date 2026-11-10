#pragma once
// Tus datos de Wi-Fi van en config.personal.h (copia config.personal.example.h). Ese archivo está ignorado por git.
#if __has_include("config.personal.h")
#include "config.personal.h"
#else
static const char WIFI_SSID[] = "TU_WIFI_2_4_GHZ";
static const char WIFI_PASSWORD[] = "TU_CLAVE_WIFI";
#endif
// Solo dominio; sin https:// ni / al final. Se actualiza con el despliegue final.
static const char CLOUD_HOST[] = "ensaia-oratoria.vercel.app";
static const int MIC_BCLK = 4;
static const int MIC_WS = 5;
static const int MIC_DATA = 6;
static const int MIC_GAIN = 1;
