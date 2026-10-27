#pragma once
// Copia como secrets.h y usa la clave individual entregada para tu dispositivo.
// NO es la clave de OpenAI. No publiques secrets.h.
static const char DEVICE_ID[] = "ensaia-s3-01";
static const char DEVICE_SECRET[] = "REEMPLAZAR_POR_LA_CLAVE_INDIVIDUAL_DEL_DISPOSITIVO";
// Vacios: el ESP32 genera usuario y contrasena y los conserva en su memoria NVS.
// Opcional: define ambos ANTES del primer registro; usuario en minusculas, clave >=16 caracteres.
static const char PROPOSED_USER[] = "";
static const char PROPOSED_PASSWORD[] = "";
