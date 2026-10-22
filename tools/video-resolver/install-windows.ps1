$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command py -ErrorAction SilentlyContinue)) { throw '请先安装 Python 3.11+，并勾选 Add Python to PATH。' }
py -3 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
Write-Host '安装完成。运行 .\.venv\Scripts\python.exe app.py 启动服务。默认仅监听本机 127.0.0.1:8765。' -ForegroundColor Green
