from app import create_app, socketio

app = create_app()

if __name__ == "__main__":
    # Dev entrypoint. Never enable the debugger on a network-facing server.
    #   gunicorn -k eventlet -w 1 run:app
    # (single worker with eventlet because Socket.IO needs a shared
    # in-memory session map; scale via a message queue, e.g. Redis, for
    # multi-worker deployments.)
    socketio.run(app, host="0.0.0.0", port=5000, debug=False)
