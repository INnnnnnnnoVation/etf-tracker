#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地一键启动：python3 serve.py [端口]，默认 8080"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")

os.chdir(ROOT)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # index.html 不缓存；JSON 允许短缓存——与方案 §5.6 缓存策略一致
        if self.path in ("/", "/index.html", "/app.js", "/styles.css"):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "max-age=300")
        super().end_headers()


with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
    print(f"✔ 汇金证金 ETF 持仓追踪（复刻验证版）已启动")
    print(f"  地址: http://localhost:{PORT}")
    print(f"  目录: {ROOT}")
    print("  Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
