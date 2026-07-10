import http.server
import socketserver
import os
import urllib.parse

PORT = 8000
DATA_DIR = os.path.dirname(os.path.abspath(__file__))

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Desencodar a URL para lidar com espaços (ex: /data/Malhas%20Territoriais/...)
        path = urllib.parse.unquote(path)
        
        if path.startswith("/data/"):
            relative_path = path[6:]
            target = os.path.join(DATA_DIR, relative_path.replace("/", os.sep))
            return target
        
        return super().translate_path(path)
        
    def end_headers(self):
        # Adicionar cabeçalhos de CORS caso necessário
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

# Garantir que roda no diretório onde o script está
os.chdir(os.path.dirname(os.path.abspath(__file__)))

with socketserver.TCPServer(("localhost", PORT), CustomHandler) as httpd:
    print("=====================================================")
    print(f" Servidor WebGIS Iniciado na porta {PORT}")
    print(f" Acesse no navegador: http://localhost:{PORT}")
    print(f" Mapeando a rota /data/ para: {DATA_DIR}")
    print("=====================================================")
    try:
        import webbrowser
        webbrowser.open(f"http://localhost:{PORT}")
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
