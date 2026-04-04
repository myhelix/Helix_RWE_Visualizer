#!/bin/bash
# Start the VUS Evidence Visualizer local server.
# Kills any existing process on the port first.
PORT=${1:-8080}
cd "$(dirname "$0")"

# Kill anything already on this port
lsof -ti tcp:$PORT | xargs kill -9 2>/dev/null && echo "Stopped previous server on $PORT."

echo "Starting server at http://localhost:$PORT"
echo "Open that URL in your browser."
echo "Press Ctrl+C to stop."
python3 serve.py $PORT
