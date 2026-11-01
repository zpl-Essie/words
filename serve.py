# 局域网预览静态服务器：所有响应禁缓存（no-store），
# 保证手机每次刷新都拿到最新代码，不用再开无痕窗口。
# 用法：python serve.py  （在 words 目录下执行）
import http.server
import socketserver
import os

PORT = 3000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        # 兜底：无扩展名的未知路径（比如手滑打成中文问号 /？agr）一律回主页，
        # 避免输错网址就 404。带扩展名的资源（css/js/图片）不存在时仍正常 404。
        try:
            clean = self.path.split("?", 1)[0].split("#", 1)[0]
            if not os.path.exists(self.translate_path(clean)) and not os.path.splitext(clean)[1]:
                self.path = "/"
        except Exception:
            pass
        return super().send_head()


if __name__ == "__main__":
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), NoCacheHandler) as httpd:
        print(f"serving on http://192.168.0.100:{PORT} (no-store)")
        httpd.serve_forever()
