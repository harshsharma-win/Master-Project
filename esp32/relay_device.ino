#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <cstring>
#include "secrets.h"

#ifndef WIFI_SSID
#error "Add WIFI_SSID to esp32/secrets.h"
#endif
#ifndef WIFI_PASSWORD
#error "Add WIFI_PASSWORD to esp32/secrets.h"
#endif
#ifndef MQTT_USER
#error "Add MQTT_USER to esp32/secrets.h"
#endif
#ifndef MQTT_PASSWORD
#error "Add MQTT_PASSWORD to esp32/secrets.h"
#endif

const char* MQTT_SERVER = "o7671639.ala.us-east-1.emqxsl.com";
const uint16_t MQTT_PORT = 8883;
const char* DEVICE_ID = "ESP32-RELAY-01";
const char* COMMAND_TOPIC = "thefool/device01/cmd";
const char* ACK_TOPIC = "thefool/device01/ack";
const char* STATUS_JSON_TOPIC = "thefool/device01/status/json";
const char* STATUS_TOPIC = "thefool/device01/status";

constexpr uint8_t MOTOR_1_PIN = 25;
constexpr uint8_t MOTOR_2_PIN = 32;
constexpr uint8_t BUTTON_PIN = 33;
constexpr uint32_t PWM_FREQUENCY = 200;
constexpr uint8_t PWM_RESOLUTION = 8;
constexpr uint8_t MOTOR_POWER = 255;
constexpr uint32_t DEFAULT_PULSE_MS = 250;
constexpr uint32_t DEFAULT_GAP_MS = 300;
constexpr uint32_t HEARTBEAT_MS = 15'000;
constexpr uint32_t WIFI_RETRY_MS = 10'000;
constexpr uint32_t MQTT_RETRY_MS = 5'000;
constexpr uint32_t BUTTON_DEBOUNCE_MS = 50;
constexpr uint32_t AUTO_REPEAT_DELAY_MS = 2'000;

WiFiClientSecure secureClient;
PubSubClient mqttClient(secureClient);
Preferences preferences;

uint8_t activeMotorPin = MOTOR_1_PIN;
uint8_t remainingPulses = 0;
uint8_t lastAnswerPulses = 0;
uint8_t lastAnswerMotor = 1;
uint32_t pulseDurationMs = DEFAULT_PULSE_MS;
uint32_t pulseGapMs = DEFAULT_GAP_MS;
uint32_t phaseStartedAt = 0;
uint32_t lastWiFiAttemptAt = 0;
uint32_t lastMqttAttemptAt = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t lastButtonChangeAt = 0;
uint32_t autoRepeatAt = 0;

bool patternRunning = false;
bool pulseOn = false;
bool autoRepeatEnabled = false;
bool autoRepeatPending = false;
bool stableButtonState = HIGH;
bool lastButtonReading = HIGH;
char lastAnswerLetter = '\0';
String currentSignal;

void sendAck(const char* signal, const char* status) {
  if (!mqttClient.connected()) return;

  StaticJsonDocument<256> document;
  document["device"] = DEVICE_ID;
  document["signal"] = signal;
  document["status"] = status;
  document["timestamp"] = millis();

  char payload[256];
  serializeJson(document, payload, sizeof(payload));
  mqttClient.publish(ACK_TOPIC, payload, true);
  Serial.printf("ACK %s: %s\n", signal, status);
}

void publishStatus(const char* state) {
  if (!mqttClient.connected()) return;

  StaticJsonDocument<320> document;
  document["device"] = DEVICE_ID;
  document["online"] = strcmp(state, "online") == 0;
  document["state"] = state;
  document["wifi"] = WiFi.status() == WL_CONNECTED;
  document["rssi"] = WiFi.RSSI();
  document["uptime"] = millis() / 1000;
  document["ip"] = WiFi.localIP().toString();
  document["autoRepeat"] = autoRepeatEnabled;
  if (lastAnswerLetter == '\0') {
    document["lastAnswer"] = "";
  } else {
    document["lastAnswer"] = String(lastAnswerLetter);
  }
  document["timestamp"] = millis();

  char payload[320];
  serializeJson(document, payload, sizeof(payload));
  mqttClient.publish(STATUS_JSON_TOPIC, payload, true);
  mqttClient.publish(STATUS_TOPIC, state, true);
  Serial.printf("Status: %s\n", payload);
}

void stopMotors() {
  ledcWrite(MOTOR_1_PIN, 0);
  ledcWrite(MOTOR_2_PIN, 0);
  patternRunning = false;
  pulseOn = false;
  remainingPulses = 0;
}

void startPattern(uint8_t motor, uint8_t pulses, uint32_t duration, uint32_t gap, const String& signal) {
  if (motor != 1 && motor != 2) {
    sendAck(signal.c_str(), "INVALID_MOTOR");
    return;
  }

  stopMotors();
  activeMotorPin = motor == 2 ? MOTOR_2_PIN : MOTOR_1_PIN;
  remainingPulses = constrain(pulses, 1, 20);
  pulseDurationMs = constrain(duration, 50UL, 5'000UL);
  pulseGapMs = constrain(gap, 50UL, 5'000UL);
  currentSignal = signal;
  patternRunning = true;
  pulseOn = true;
  phaseStartedAt = millis();
  ledcWrite(activeMotorPin, MOTOR_POWER);
  sendAck(signal.c_str(), "RECEIVED");
}

void rememberAnswer(uint8_t optionNumber, uint8_t motor, uint8_t pulses) {
  lastAnswerLetter = static_cast<char>('A' + optionNumber - 1);
  lastAnswerPulses = constrain(pulses, 1, 4);
  lastAnswerMotor = motor == 2 ? 2 : 1;
  preferences.putChar("answer", lastAnswerLetter);
  preferences.putUChar("answerPulses", lastAnswerPulses);
  preferences.putUChar("answerMotor", lastAnswerMotor);
}

void repeatLastAnswer(const char* signal) {
  if (lastAnswerLetter < 'A' || lastAnswerLetter > 'D' || lastAnswerPulses == 0) {
    sendAck(signal, "NO_PREVIOUS_ANSWER");
    return;
  }

  startPattern(lastAnswerMotor, lastAnswerPulses, DEFAULT_PULSE_MS, DEFAULT_GAP_MS, signal);
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (length == 0 || length >= 512) {
    sendAck("UNKNOWN", "INVALID_PAYLOAD");
    return;
  }

  StaticJsonDocument<512> document;
  const DeserializationError error = deserializeJson(document, payload, length);
  if (error) {
    sendAck("UNKNOWN", "INVALID_JSON");
    return;
  }

  const char* signal = document["signal"] | "";
  if (!signal[0]) {
    sendAck("UNKNOWN", "MISSING_SIGNAL");
    return;
  }

  const uint8_t motor = document["motor"] | 1;
  const uint8_t requestedPulses = document["vibrations"] | 1;
  const uint32_t duration = document["pulseDuration"] | DEFAULT_PULSE_MS;
  const uint32_t gap = document["pulseGap"] | DEFAULT_GAP_MS;

  if (strcmp(signal, "STOP") == 0) {
    stopMotors();
    sendAck(signal, "STOPPED");
    return;
  }

  if (strcmp(signal, "SET_AUTO_REPEAT") == 0) {
    autoRepeatEnabled = document["enabled"] | false;
    preferences.putBool("autoRepeat", autoRepeatEnabled);
    publishStatus("online");
    sendAck(signal, autoRepeatEnabled ? "ENABLED" : "DISABLED");
    return;
  }

  if (strcmp(signal, "OPTION_1") == 0 || strcmp(signal, "OPTION_2") == 0 ||
      strcmp(signal, "OPTION_3") == 0 || strcmp(signal, "OPTION_4") == 0) {
    const uint8_t optionNumber = static_cast<uint8_t>(signal[strlen(signal) - 1] - '0');
    const uint8_t pulses = constrain(requestedPulses, 1, 4);
    rememberAnswer(optionNumber, motor, pulses);
    startPattern(motor, pulses, duration, gap, signal);
    publishStatus("online");
    return;
  }

  if (strcmp(signal, "REPEAT_OPTION") == 0 || strcmp(signal, "REPEAT_ANSWER") == 0) {
    repeatLastAnswer(signal);
    return;
  }

  if (strcmp(signal, "REPEAT_QUESTION") == 0) {
    startPattern(motor, 2, 700, 400, signal);
    return;
  }

  if (strcmp(signal, "QUICK_MOTOR_2") == 0) {
    startPattern(2, requestedPulses, duration, gap, signal);
    return;
  }

  if (strcmp(signal, "CUSTOM_PATTERN") == 0) {
    startPattern(motor, requestedPulses, duration, gap, signal);
    return;
  }

  sendAck(signal, "UNKNOWN_COMMAND");
}

void updateMotors() {
  if (!patternRunning || static_cast<uint32_t>(millis() - phaseStartedAt) < (pulseOn ? pulseDurationMs : pulseGapMs)) return;

  if (pulseOn) {
    ledcWrite(activeMotorPin, 0);
    pulseOn = false;
    if (--remainingPulses == 0) {
      patternRunning = false;
      sendAck(currentSignal.c_str(), "EXECUTED");
      return;
    }
    phaseStartedAt = millis();
    return;
  }

  pulseOn = true;
  phaseStartedAt = millis();
  ledcWrite(activeMotorPin, MOTOR_POWER);
}

void updateAutoRepeat() {
  if (!autoRepeatPending || static_cast<int32_t>(millis() - autoRepeatAt) < 0) return;

  autoRepeatPending = false;
  if (!autoRepeatEnabled) return;
  repeatLastAnswer("AUTO_REPEAT");
}

void updateButton() {
  const bool reading = digitalRead(BUTTON_PIN);
  const uint32_t now = millis();

  if (reading != lastButtonReading) lastButtonChangeAt = now;
  if (now - lastButtonChangeAt >= BUTTON_DEBOUNCE_MS && reading != stableButtonState) {
    stableButtonState = reading;
    if (stableButtonState == LOW) {
      sendAck("DEVICE_BUTTON", "PRESSED");
      if (!autoRepeatEnabled) {
        sendAck("AUTO_REPEAT", "DISABLED");
      } else if (lastAnswerLetter < 'A' || lastAnswerLetter > 'D') {
        sendAck("AUTO_REPEAT", "NO_PREVIOUS_ANSWER");
      } else {
        autoRepeatAt = now + AUTO_REPEAT_DELAY_MS;
        autoRepeatPending = true;
        sendAck("AUTO_REPEAT", "SCHEDULED_2S");
      }
    }
  }
  lastButtonReading = reading;
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  const uint32_t now = millis();
  if (lastWiFiAttemptAt != 0 && now - lastWiFiAttemptAt < WIFI_RETRY_MS) return;
  lastWiFiAttemptAt = now;
  Serial.printf("Connecting to WiFi: %s\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void connectMqtt() {
  if (mqttClient.connected() || WiFi.status() != WL_CONNECTED) return;
  const uint32_t now = millis();
  if (lastMqttAttemptAt != 0 && now - lastMqttAttemptAt < MQTT_RETRY_MS) return;
  lastMqttAttemptAt = now;

  String clientId = String("relay-") + String(static_cast<uint32_t>(ESP.getEfuseMac()), HEX);
  const char* offlinePayload = "{\"device\":\"ESP32-RELAY-01\",\"online\":false,\"state\":\"offline\"}";
  mqttClient.setWill(STATUS_JSON_TOPIC, offlinePayload, true, 1);

  Serial.println("Connecting to MQTT broker...");
  if (!mqttClient.connect(clientId.c_str(), MQTT_USER, MQTT_PASSWORD)) {
    Serial.printf("MQTT connection failed, state=%d\n", mqttClient.state());
    return;
  }

  mqttClient.subscribe(COMMAND_TOPIC, 1);
  publishStatus("online");
  sendAck("DEVICE", "CONNECTED");
  Serial.println("MQTT connected; subscribed to command topic.");
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(MOTOR_1_PIN, OUTPUT);
  pinMode(MOTOR_2_PIN, OUTPUT);

  preferences.begin("relay", false);
  autoRepeatEnabled = preferences.getBool("autoRepeat", false);
  lastAnswerLetter = preferences.getChar("answer", '\0');
  lastAnswerPulses = preferences.getUChar("answerPulses", 0);
  lastAnswerMotor = preferences.getUChar("answerMotor", 1);

  const bool motor1Ready = ledcAttach(MOTOR_1_PIN, PWM_FREQUENCY, PWM_RESOLUTION);
  const bool motor2Ready = ledcAttach(MOTOR_2_PIN, PWM_FREQUENCY, PWM_RESOLUTION);
  stopMotors();
  Serial.printf("Motor GPIO %u: %s\n", MOTOR_1_PIN, motor1Ready ? "READY" : "FAILED");
  Serial.printf("Motor GPIO %u: %s\n", MOTOR_2_PIN, motor2Ready ? "READY" : "FAILED");
  Serial.printf("Auto-repeat: %s\n", autoRepeatEnabled ? "ON" : "OFF");

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  secureClient.setCACert(MQTT_ROOT_CA);
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);
  mqttClient.setKeepAlive(30);
  mqttClient.setSocketTimeout(5);
  connectWiFi();
}

void loop() {
  connectWiFi();
  connectMqtt();

  if (mqttClient.connected()) {
    mqttClient.loop();
  }

  updateButton();
  updateAutoRepeat();
  updateMotors();

  if (mqttClient.connected() && static_cast<uint32_t>(millis() - lastHeartbeatAt) >= HEARTBEAT_MS) {
    lastHeartbeatAt = millis();
    publishStatus("online");
  }
}
