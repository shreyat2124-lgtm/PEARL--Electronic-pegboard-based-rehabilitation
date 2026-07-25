# PEARL — Portable Electronics Assisted Rehabilitation for Upper Limbs

A hardware + software rehabilitation system that combines a Hall-effect sensor pegboard with a machine learning pipeline to guide patient therapy progression. Built as a group project combining embedded systems, full-stack development, and applied ML on real clinical data.

## Overview

PEARL helps therapists assess and progress patients through upper limb motor rehabilitation exercises. A physical pegboard with embedded sensors captures hand movement and reaction data during therapy sessions, which is logged via a Firebase backed web dashboard. A trained classifier then recommends whether a patient should be promoted, maintained, or demoted to a different difficulty level thus reducing manual assessment overhead for clinicians.

## System Architecture
PEARL/
├── electronics-hardware/ # Arduino firmware — sensor input, LED output, level logic
├── frontend/ # Web dashboard — doctor login, sessions, patient management
└── ml-pipeline/ # Classifier — real-data model + synthetic exploration
## Hardware (`/electronics-hardware`)

4×4 Hall-effect sensor pegboard built on a custom PCB, controlled via Arduino:
- Multiplexed sensor reads (2× 8-channel mux) for 16 sensor positions
- 74HC595 shift registers driving individually addressable peg LEDs
- Six therapy modes implemented in firmware: free play, sequential targeting, randomized targets, short-term memory recall, bilateral coordination, and a peak-performance mixed mode
- Adaptive timeout-per-level and serial protocol for live communication with the web dashboard

*Developed by a teammate as part of the group project.*

## Frontend (`/frontend`)

Firebase-backed clinical web app covering the full session workflow:
- Doctor authentication
- Pre-session patient assessment (auto-suggests starting difficulty level)
- Live therapy session view with real-time hit/accuracy tracking synced to hardware
- Post-session results dashboard with charts and an AI-driven level recommendation
- Patient records management and dataset export

*Developed by a teammate as part of the group project.*

## Machine Learning Pipeline (`/ml-pipeline`)

**Goal:** predict whether a patient should be promoted, maintained, or demoted in therapy level based on session performance (accuracy, reaction time, fatigue index, and per-target timing features).

**Files:**
- `PEARL_ML_final.ipynb` — final pipeline, trained and evaluated on real clinical session data
- `synthetic_data_exploration.ipynb` — earlier exploration on a larger synthetic dataset, used to validate the modeling approach before real data collection
- `pearl_ml_dataset_2026-05-18.csv` — clinical session dataset

**Approach:**
- Feature engineering from raw session logs (reaction time trends, fatigue index, per-target timing)
- Addressed a data leakage issue by moving SMOTE class balancing to training data only, after the initial train/test split
- Benchmarked 5 classifiers (Decision Tree, Random Forest, SVM, KNN, Naive Bayes)

**Result:** Decision Tree performed best on real clinical data — **90.9% accuracy, F1 0.867** — evaluated on a held-out set of 11 real patient samples. Given the small clinical sample size, this was cross-checked against an earlier model (SVM, 89.1%) trained on a larger synthetic dataset to confirm the modeling pipeline generalized reasonably before being validated on real data.

## My Contribution

This repository is maintained by me. My work covers the complete ML pipeline — data preprocessing, feature engineering, the SMOTE leakage fix, model benchmarking, and evaluation — documented in `/ml-pipeline`. Hardware and frontend components were built by a teammate and are included here for full-system context, with credit above.

## Tech Stack

**Hardware:** Arduino, C++, Hall-effect sensors, multiplexers, shift registers
**Frontend:** HTML/CSS/JavaScript, Firebase (Auth + Firestore)
**ML:** Python, scikit-learn, imbalanced-learn (SMOTE), pandas, matplotlib
