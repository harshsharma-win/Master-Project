#pragma once

#define WIFI_SSID "your-wifi-network"
#define WIFI_PASSWORD "your-wifi-password"
#define MQTT_USER "your-dedicated-emqx-user"
#define MQTT_PASSWORD "replace-with-a-new-broker-password"

static const char MQTT_ROOT_CA[] PROGMEM = R"CERT(
-----BEGIN CERTIFICATE-----
PASTE_THE_CA_CERTIFICATE_DOWNLOADED_FROM_EMQX_CLOUD_HERE
-----END CERTIFICATE-----
)CERT";
