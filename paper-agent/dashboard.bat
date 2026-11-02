@echo off
cd /d "%~dp0"
start "" http://localhost:7070
node server.js
