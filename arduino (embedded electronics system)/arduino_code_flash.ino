#include <math.h>

// -------- MUX --------
int S0 = 2;
int S1 = 3;
int S2 = 4;
int mux1SIG = 5;
int mux2SIG = 6;

// -------- SHIFT REGISTER --------
int dataPin = 11;
int clockPin = 12;
int latchPin = 8;

// -------- PANEL --------
int powerLED = 7;
int systemLED = 9;
int errorLED = 10;
int webLED = A4;
int buzzer = A2;

// -------- STATE --------
int currentTarget = -1;
int previousTarget = -1;
bool previousTargetReleased = true;
bool gameActive = false;
bool connected = false;
int currentLevel = 0;
int sequenceIndex = 0;
int targetCount = 0;
int memSequence[3];
int memStep = 0;
unsigned long memTimer = 0;
unsigned long targetTimer = 0;

// -------- SENSOR MAP --------
int sensorMap[16] = {
  0,2,4,6,
  1,3,5,7,
  8,10,12,14,
  9,11,13,15
};

// -------- LED MAP --------
int ledMap[16] = {
  0,2,4,6,
  1,3,5,7,
  8,10,12,14,
  9,11,13,15
};

// -------- ERROR --------
unsigned long errorTimer = 0;
bool errorActive = false;

// -------- SERIAL --------
unsigned long lastSerialTime = 0;

// -------- LED CONTROL --------
void setRawLED(uint16_t state) {
  digitalWrite(latchPin, LOW);
  shiftOut(dataPin, clockPin, MSBFIRST, highByte(state));
  shiftOut(dataPin, clockPin, MSBFIRST, lowByte(state));
  digitalWrite(latchPin, HIGH);
}

void clearLEDs() {
  setRawLED(0);
}

void setLED(int logicalIndex) {
  int physical = ledMap[logicalIndex];
  setRawLED(1 << physical);
}

// -------- IDLE WAVE --------
void idleWave() {
  static int waveIndex = 0;
  int border[] = {0,1,2,3,7,11,15,14,13,12,8,4};

  setLED(border[waveIndex]);

  waveIndex++;
  if (waveIndex >= 12) waveIndex = 0;

  delay(120);
}

// -------- NEW POWER-UP ANIMATION --------
void connectionAnimation() {

  // rising + fall tone (feels like system boot)
  tone(buzzer, 1200); delay(80);
  tone(buzzer, 1800); delay(80);
  tone(buzzer, 2600); delay(120);
  tone(buzzer, 2000); delay(100);
  noTone(buzzer);

  // swirl animation
  int swirl[] = {0,5,10,15,14,13,12,8,4,1,2,3,7,11};

  for (int i = 0; i < 14; i++) {
    setLED(swirl[i]);
    delay(60);
  }

  // pulse all LEDs (power ready effect)
  for (int i = 0; i < 3; i++) {
    setRawLED(0xFFFF);
    delay(80);
    clearLEDs();
    delay(80);
  }
}

// -------- SENSOR --------
void selectChannel(int ch) {
  digitalWrite(S0, ch & 1);
  digitalWrite(S1, (ch >> 1) & 1);
  digitalWrite(S2, (ch >> 2) & 1);
}

bool isTriggered(int logicalIndex) {
  int physical = sensorMap[logicalIndex];
  int muxCh = physical % 8;

  selectChannel(muxCh);
  delayMicroseconds(50);

  if (physical < 8) return digitalRead(mux1SIG) == LOW;
  else return digitalRead(mux2SIG) == LOW;
}

// -------- WRONG HIT --------
int detectWrongHit() {
  if (currentLevel == 0) return -1;

  if (!previousTargetReleased && previousTarget != -1) {
    if (!isTriggered(previousTarget)) {
      previousTargetReleased = true;
    }
  }

  for (int i = 0; i < 16; i++) {
    if (i == currentTarget) continue;
    if (!previousTargetReleased && i == previousTarget) continue;

    if (isTriggered(i)) {
      return i;
    }
  }
  return -1;
}

// -------- LEVEL CONTROL --------
void setLevel(int lvl) {
  currentLevel = lvl;
  currentTarget = -1;
  sequenceIndex = 0;
  targetCount = 0;
  memStep = 0;
}

unsigned long getTimeoutForLevel(int lvl) {
  switch(lvl) {
    case 1: return 60000;   // 1.0 minute (60s)
    case 2: return 90000;   // 1.5 minutes (90s)
    case 3: return 120000;  // 2.0 minutes (120s)
    case 4: return 150000;  // 2.5 minutes (150s)
    case 5: return 180000;  // 3.0 minutes (180s)
    default: return 60000;
  }
}

void checkTimeout() {
  if (currentTarget != -1 && currentLevel >= 1) {
    if (millis() - targetTimer > getTimeoutForLevel(currentLevel)) {
      Serial.println("RESTART");
      
      // Long losing tone and flashing LEDs
      tone(buzzer, 600); 
      setRawLED(0xFFFF); // All LEDs ON
      delay(400); 
      
      tone(buzzer, 400); 
      setRawLED(0x0000); // All LEDs OFF
      delay(400); 
      
      tone(buzzer, 200); 
      setRawLED(0xFFFF); // All LEDs ON
      delay(1000);       // Long low tone
      
      noTone(buzzer);
      clearLEDs();
      
      // Pause before actually resetting and sending the next target
      delay(1000);
      
      setLevel(currentLevel);
    }
  }
}

// -------- LEVEL 0 --------
void level0_free() {
  for (int i = 0; i < 16; i++) {
    if (isTriggered(i)) {
      setLED(i);
      delay(80);
      clearLEDs();
    }
  }
}

// -------- LEVEL 1 --------
void level1_sequence() {

  if (currentTarget == -1) {
    currentTarget = sequenceIndex;
    Serial.print("T:");
    Serial.println(currentTarget);
    setLED(currentTarget);
    targetTimer = millis();
  }

  checkTimeout();

  if (isTriggered(currentTarget)) {
    previousTarget = currentTarget;
    previousTargetReleased = false;

    Serial.print("H:");
    Serial.println(currentTarget);

    tone(buzzer, 3000);
    delay(100);
    noTone(buzzer);

    clearLEDs();
    delay(120);

    sequenceIndex++;
    if (sequenceIndex >= 16) {
      Serial.println("END");
      gameActive = false;
      sequenceIndex = 0;
    }
    currentTarget = -1;
  }
}

// -------- LEVEL 2 --------
void level2_random() {

  if (currentTarget == -1) {
    do {
      currentTarget = random(0, 16);
    } while (currentTarget == previousTarget);

    Serial.print("T:");
    Serial.println(currentTarget);

    setLED(currentTarget);
    targetTimer = millis();
  }

  checkTimeout();

  if (isTriggered(currentTarget)) {
    previousTarget = currentTarget;
    previousTargetReleased = false;

    Serial.print("H:");
    Serial.println(currentTarget);

    tone(buzzer, 3000);
    delay(120);
    noTone(buzzer);

    clearLEDs();
    delay(200);

    targetCount++;
    if (targetCount >= 16) {
      Serial.println("END");
      gameActive = false;
    }
    currentTarget = -1;
  }
}

// -------- LEVEL 3 --------
void level3_memory() {
  if (sequenceIndex == 0 && targetCount < 5) {
    for(int i=0; i<3; i++) {
       do {
         memSequence[i] = random(0, 16);
       } while ((i > 0 && memSequence[i] == memSequence[i-1]) || (i == 0 && memSequence[i] == previousTarget));
    }
    uint16_t state = 0;
    for(int i=0; i<3; i++) state |= (1 << ledMap[memSequence[i]]);
    setRawLED(state);
    memTimer = millis();
    sequenceIndex = 1; 
  }
  
  if (sequenceIndex == 1) {
    if (millis() - memTimer > 3000) {
      clearLEDs();
      sequenceIndex = 2; 
      memStep = 0;
      currentTarget = -1;
    }
  }

  if (sequenceIndex == 2) {
    if (currentTarget == -1) {
      currentTarget = memSequence[memStep];
      Serial.print("T:");
      Serial.println(currentTarget);
      targetTimer = millis();
    }
    
    checkTimeout();
    
    if (isTriggered(currentTarget)) {
      previousTarget = currentTarget;
      previousTargetReleased = false;

      Serial.print("H:");
      Serial.println(currentTarget);
      tone(buzzer, 3000); delay(100); noTone(buzzer);
      memStep++;
      currentTarget = -1;
      
      if (memStep >= 3) {
         targetCount++;
         if (targetCount >= 5) { 
           Serial.println("END");
           gameActive = false;
         } else {
           sequenceIndex = 0; 
         }
      }
    }
  }
}

// -------- LEVEL 4 --------
void level4_bilateral() {
  if (currentTarget == -1) {
    if (targetCount % 2 == 0) {
       currentTarget = random(0, 4) * 4 + random(0, 2);
    } else {
       currentTarget = random(0, 4) * 4 + random(2, 4);
    }
    Serial.print("T:"); Serial.println(currentTarget);
    setLED(currentTarget);
    targetTimer = millis();
  }
  
  checkTimeout();
  
  if (isTriggered(currentTarget)) {
    previousTarget = currentTarget;
    previousTargetReleased = false;

    Serial.print("H:"); Serial.println(currentTarget);
    tone(buzzer, 3000); delay(100); noTone(buzzer);
    clearLEDs(); delay(200);
    
    targetCount++;
    if (targetCount >= 16) {
      Serial.println("END");
      gameActive = false;
    }
    currentTarget = -1;
  }
}

// -------- LEVEL 5 --------
void level5_peak() {
  if (currentTarget == -1) {
    do {
      currentTarget = random(0, 16);
    } while (currentTarget == previousTarget);
    
    Serial.print("T:"); Serial.println(currentTarget);
    
    uint16_t state = (1 << ledMap[currentTarget]);
    for(int i=0; i<5; i++) {
       int dist = random(0, 16);
       state |= (1 << ledMap[dist]);
    }
    setRawLED(state);
    targetTimer = millis();
  }

  checkTimeout();
  
  if (isTriggered(currentTarget)) {
    previousTarget = currentTarget;
    previousTargetReleased = false;

    Serial.print("H:"); Serial.println(currentTarget);
    tone(buzzer, 3000); delay(100); noTone(buzzer);
    clearLEDs(); delay(200);
    targetCount++;
    currentTarget = -1;
  }

  if (targetCount >= 16 && currentTarget == -1) {
    Serial.println("END");
    gameActive = false;
  }
}

// -------- SETUP --------
void setup() {

  Serial.begin(115200);

  pinMode(S0, OUTPUT);
  pinMode(S1, OUTPUT);
  pinMode(S2, OUTPUT);

  pinMode(mux1SIG, INPUT);
  pinMode(mux2SIG, INPUT);

  pinMode(dataPin, OUTPUT);
  pinMode(clockPin, OUTPUT);
  pinMode(latchPin, OUTPUT);

  pinMode(powerLED, OUTPUT);
  pinMode(systemLED, OUTPUT);
  pinMode(errorLED, OUTPUT);
  pinMode(webLED, OUTPUT);
  pinMode(buzzer, OUTPUT);

  digitalWrite(powerLED, HIGH);

  randomSeed(analogRead(A0));

  delay(1000);

  // startup chime
  tone(buzzer, 1500); delay(120);
  tone(buzzer, 1800); delay(120);
  noTone(buzzer);
}

// -------- SYSTEM LED --------
void updateSystemLED() {
  digitalWrite(systemLED, (millis() / 400) % 2);
}

// -------- ERROR LED --------
void updateErrorLED() {

  if (!errorActive) {
    analogWrite(errorLED, 40);
  } else {
    analogWrite(errorLED, (millis() / 100) % 2 ? 255 : 0);
  }

  if (errorActive && millis() - errorTimer > 500) {
    errorActive = false;
  }
}

// -------- WEB LED --------
void updateWebLED() {

  if (!connected) {
    digitalWrite(webLED, HIGH);
  }
  else if (millis() - lastSerialTime < 200) {
    digitalWrite(webLED, (millis() / 100) % 2);
  }
  else {
    digitalWrite(webLED, (millis() / 500) % 2);
  }
}

// -------- LOOP --------
void loop() {

  updateSystemLED();
  updateErrorLED();
  updateWebLED();

  if (!connected) {
    idleWave();
  }

  // -------- SERIAL --------
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');

    if (cmd == "CONNECTED") {
      connected = true;
      connectionAnimation();
      lastSerialTime = millis();
    }

    if (cmd == "START") {
      gameActive = true;
      currentTarget = -1;
      targetCount = 0;
      sequenceIndex = 0;
      lastSerialTime = millis();
    }

    if (cmd.startsWith("LEVEL:")) {
      int lvl = cmd.substring(6).toInt();
      setLevel(lvl);
    }
  }

  if (!gameActive) return;

  // -------- LEVEL SWITCH --------
  switch (currentLevel) {
    case 0: level0_free(); break;
    case 1: level1_sequence(); break;
    case 2: level2_random(); break;
    case 3: level3_memory(); break;
    case 4: level4_bilateral(); break;
    case 5: level5_peak(); break;
    default: level2_random(); break;
  }

  // -------- WRONG HIT --------
  int wrong = detectWrongHit();

  if (wrong != -1) {

    Serial.print("W:");
    Serial.println(wrong);

    tone(buzzer, 1200);
    delay(150);
    noTone(buzzer);

    errorActive = true;
    errorTimer = millis();
  }

  delay(40);
}