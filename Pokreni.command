#!/bin/bash
# Dupli klik: pokrece Beep Beep Radio na http://localhost:8743
# Ostavi ovaj prozor otvoren dok player radi. Zatvori ga kad zavrsis.
cd "$(dirname "$0")"
PORT=8743
echo "Beep Beep Radio radi na http://localhost:$PORT"
echo "Ne zatvaraj ovaj prozor dok player radi."
( sleep 1; open "http://localhost:$PORT" ) &
python3 -m http.server $PORT
