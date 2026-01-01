#!/usr/bin/env python3
"""
Lightweight static server for the HKUST LoRaWAN Dashboard.

Usage:
  python3 serve.py --port 5173 --dir .

Then open:
  http://localhost:5173/visualize.html
"""

import argparse
import http.server
import os
import socketserver
import sys
import webbrowser
from pathlib import Path

class NoCacheRequestHandler(http.server.SimpleHTTPRequestHandler):
    # Add/override MIME types that matter for modern frontends
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js":  "text/javascript",
        ".json":"application/json",
        ".wasm":"application/wasm",
        ".svg": "image/svg+xml",
        ".csv": "text/csv",
        "": "application/octet-stream",
    }

    def end_headers(self):
        # Disable caching (so CSV changes are immediately visible)
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        # Optional: allow CORS (handy if you test from another port)
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_GET(self):
        # If user opens "/", serve visualize.html (if present)
        if self.path in ("/", "/index.html"):
            visualize = Path(self.directory) / "visualize.html"
            if visualize.exists():
                self.path = "/visualize.html"
        return super().do_GET()

def main():
    parser = argparse.ArgumentParser(description="Serve static files with no-cache headers.")
    parser.add_argument("--host", default="127.0.0.1", help="Host/IP to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=5173, help="Port to bind (default: 5173)")
    parser.add_argument("--dir", default=".", help="Directory to serve (default: current dir)")
    parser.add_argument("--no-open", action="store_true", help="Do not auto-open the browser")
    args = parser.parse_args()

    serve_dir = os.path.abspath(args.dir)
    os.chdir(serve_dir)

    handler_class = lambda *h_args, **h_kwargs: NoCacheRequestHandler(*h_args, directory=serve_dir, **h_kwargs)
    with socketserver.ThreadingTCPServer((args.host, args.port), handler_class) as httpd:
        url = f"http://{args.host}:{args.port}/visualize.html"
        print(f"Serving {serve_dir}")
        print(f"→ {url}")
        print("Press Ctrl+C to stop.")
        if not args.no_open:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down…")
            httpd.shutdown()

if __name__ == "__main__":
    sys.exit(main())