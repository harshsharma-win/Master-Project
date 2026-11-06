// Copy this file to the ESP32 Arduino sketch folder.
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "Harsh1";
const char* WIFI_PASSWORD = "00998877";

const char* MQTT_SERVER = "o7671639.ala.us-east-1.emqxsl.com";
const int MQTT_PORT = 8883;
const char* MQTT_USER = "harsh";
const char* MQTT_PASSWORD = "harsh1";

const char* DEVICE_ID = "ESP32-RELAY-01";
const char* COMMAND_TOPIC = "thefool/device01/cmd";
const char* ACK_TOPIC = "thefool/device01/ack";
const char* STATUS_TOPIC = "thefool/device01/status";
const char* STATUS_JSON_TOPIC = "thefool/device01/status/json";

#define LED_1 25
#define LED_2 26

WiFiClientSecure secureClient;
PubSubClient mqttClient(secureClient);

int activeLED = LED_1;
int remainingPulses = 0;
bool patternRunning = false;
bool ledIsOn = false;
unsigned long phaseDeadline = 0;
unsigned long pulseDuration = 250;
unsigned long pulseGap = 250;
String currentSignal = "";

unsigned long lastHeartbeatAt = 0;
unsigned long lastMqttAttemptAt = 0;
unsigned long lastWiFiAttemptAt = 0;
const unsigned long heartbeatInterval = 15_000;

void publishStatus(const char* state) {
  if (!mqttClient.connected()) return;

  StaticJsonDocument<256> status;
  status["device"] = DEVICE_ID;
  status["online"] = strcmp(state, "online") == 0;
  status["state"] = state;
  status["wifi"] = WiFi.status() == WL_CONNECTED;
  status["rssi"] = WiFi.RSSI();
  status["uptime"] = millis() / 1000;
  status["ip"] = WiFi.localIP().toString();
  status["timestamp"] = millis();

  char buffer[256];
  serializeJson(status, buffer);
  mqttClient.publish(STATUS_JSON_TOPIC, buffer, true);
  mqttClient.publish(STATUS_TOPIC, state, true);

  Serial.print("Status: ");
  Serial.println(buffer);
}

void sendACK(const String& signal, const char* status) {
  StaticJsonDocument<200> doc;
  doc["device"] = DEVICE_ID;
  doc["signal"] = signal;
  doc["status"] = status;
  doc["timestamp"] = millis();

  char buffer[200];
  serializeJson(doc, buffer);
  mqttClient.publish(ACK_TOPIC, buffer, false);

  Serial.print("ACK: ");
  Serial.println(buffer);
}

void stopPattern() {
  digitalWrite(LED_1, LOW);
  digitalWrite(LED_2, LOW);
  patternRunning = false;
  ledIsOn = false;
  remainingPulses = 0;
}

void startPattern(int led, int count, unsigned long duration, const String& signal) {
  stopPattern();
  activeLED = led;

  if (count <= 0) return;

  remainingPulses = count - 1;
  pulseDuration = duration;
  currentSignal = signal;
  patternRunning = true;
  ledIsOn = true;
  digitalWrite(activeLED, HIGH);
  phaseDeadline = millis() + pulseDuration;

  Serial.println("Pattern started");
}

void startPattern(int led, int count, unsigned long duration, unsigned long gap, const String& signal) {
  pulseGap = gap;
  startPattern(led, count, duration, signal);
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.println("\nNew MQTT command received");

  if (length >= 300) {
    Serial.println("Payload too large");
    return;
  }

  char message[300];
  memcpy(message, payload, length);
  message[length] = '\0';
  Serial.println(message);

  StaticJsonDocument<300> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.println("Invalid JSON");
    sendACK("UNKNOWN", "INVALID_JSON");
    return;
  }

  String signal = doc["signal"] | "";
  int motor = doc["motor"] | 1;
  int vibrations = doc["vibrations"] | 1;
  unsigned long customDuration = doc["pulseDuration"] | 250;
  unsigned long customGap = doc["pulseGap"] | 250;

  if (signal == "STOP") {
    stopPattern();
    sendACK(signal, "STOPPED");
    return;
  }

  int selectedLED = motor == 2 ? LED_2 : LED_1;

  if (signal == "OPTION_1" || signal == "OPTION_2" ||
      signal == "OPTION_3" || signal == "OPTION_4") {
    startPattern(selectedLED, constrain(vibrations, 1, 4), 250, signal);
  } else if (signal == "QUICK_MOTOR_2") {
    startPattern(LED_2, constrain(vibrations, 1, 12), 250, signal);
  } else if (signal == "REPEAT_QUESTION") {
    startPattern(selectedLED, 2, 700, signal);
  } else if (signal == "REPEAT_OPTION") {
    startPattern(selectedLED, 3, 250, signal);
  } else if (signal == "CUSTOM_PATTERN") {
    customDuration = constrain(customDuration, 50, 5000);
    customGap = constrain(customGap, 50, 5000);
    startPattern(selectedLED, constrain(vibrations, 1, 20), customDuration, customGap, signal);
  } else {
    Serial.println("Unknown command");
    sendACK(signal, "UNKNOWN_COMMAND");
    return;
  }

  sendACK(signal, "RECEIVED");
}

void updatePattern() {
  if (!patternRunning || (int32_t)(millis() - phaseDeadline) < 0) return;

  if (ledIsOn) {
    digitalWrite(activeLED, LOW);
    ledIsOn = false;

    if (remainingPulses <= 0) {
      patternRunning = false;
      sendACK(currentSignal, "EXECUTED");
      Serial.println("Pattern completed");
    } else {
      phaseDeadline = millis() + pulseGap;
    }
  } else {
    remainingPulses--;
    digitalWrite(activeLED, HIGH);
    ledIsOn = true;
    phaseDeadline = millis() + pulseDuration;
  }
}

void connectWiFi() {
  if (millis() - lastWiFiAttemptAt < 2_000) return;
  lastWiFiAttemptAt = millis();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println("Connecting to WiFi");
}

bool connectMQTT() {
  if (!mqttClient.connected()) {
    Serial.print("Connecting to MQTT...");

    String clientID = "THEFOOL_ESP32_" + String((uint32_t)ESP.getEfuseMac(), HEX);
    mqttClient.setWill(STATUS_JSON_TOPIC, "{\"device\":\"ESP32-RELAY-01\",\"online\":false,\"state\":\"offline\"}", true, 0);

    bool connected;
    if (strlen(MQTT_USER) > 0) {
      connected = mqttClient.connect(clientID.c_str(), MQTT_USER, MQTT_PASSWORD);
    } else {
      connected = mqttClient.connect(clientID.c_str());
    }

    if (!connected) {
      Serial.print(" Failed. State: ");
      Serial.println(mqttClient.state());
      return false;
    }

    mqttClient.subscribe(COMMAND_TOPIC);
    publishStatus("online");
    Serial.println(" Connected and subscribed.");
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_1, OUTPUT);
  pinMode(LED_2, OUTPUT);
  stopPattern();

  secureClient.setInsecure();
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);
  mqttClient.setKeepAlive(30);

  connectWiFi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    stopPattern();
    connectWiFi();
    return;
  }

  updatePattern();

  if (!mqttClient.connected()) {
    stopPattern();
    if ((uint32_t)(millis() - lastMqttAttemptAt) >= 3_000) {
      lastMqttAttemptAt = millis();
      connectMQTT();
    }
    return;
  }

  mqttClient.loop();

  if ((uint32_t)(millis() - lastHeartbeatAt) >= heartbeatInterval) {
    lastHeartbeatAt = millis();
    publishStatus("online");
  }
}
