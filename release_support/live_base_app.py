import ipaddress
import json
import os
import uuid
import time
import logging
import io
import zipfile
import shutil
import tempfile
import threading
import hashlib
import re
import base64
import subprocess
import socket
import errno
from pathlib import Path
try:
    from send2trash import send2trash as _trash_send
except ImportError:
    _trash_send = None
from datetime import datetime, timedelta
from logging.handlers import RotatingFileHandler
from concurrent.futures import ThreadPoolExecutor, as_completed, wait, FIRST_COMPLETED
from urllib.parse import urlparse, parse_qs, quote
import requests
from PIL import Image, ImageOps, ImageDraw
from flask import Flask, jsonify, request, render_template, send_from_directory, send_file

# 防止解压炸弹：限制PIL最大像素数（1亿像素≈10K×10K）
Image.MAX_IMAGE_PIXELS = 100_000_000

app = Flask(__name__)
app.config['TEMPLATES_AUTO_RELOAD'] = True
app.jinja_env.auto_reload = True
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

# 上传大小限制 10MB
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB，支持超大原图上传（前端裁剪后仍可能较大）

# 全局数据锁，防止并发读写竞态
data_lock = threading.RLock()

# 大图解码/缩放是高内存操作。即使用户仍开着旧版前端，也只允许后台逐张处理，
# 避免 3～10 张三千万像素实拍图同时进入 Pillow 导致本地服务被系统杀掉。
image_upload_processing_semaphore = threading.BoundedSemaphore(1)

# 电商批量生图：批次状态写盘，后台运行不依赖浏览器页面常驻。
ECOMMERCE_DATA_FILE = 'ecommerce_batches.json'
ecommerce_lock = threading.RLock()
ecommerce_runner_executor = ThreadPoolExecutor(max_workers=1)
ecommerce_active_runners = set()
ecommerce_profile_locks = {}
ecommerce_reference_locks = {}
ecommerce_reference_data_cache = {}
ECOMMERCE_REFERENCE_DATA_CACHE_MAX = 48
ECOMMERCE_MAX_CONCURRENCY = 100
ecommerce_rerun_item_locks = {}
# 每次后端进程启动都有唯一身份。废片重做项记录处理它的进程；热重载后
# worker_id 不一致就能确认旧请求已经失去本地执行者，而不是长期假装 running。
ECOMMERCE_PROCESS_ID = uuid.uuid4().hex
# 归档文件名的“检查是否存在 + 选择后缀 + 写入”必须是一个原子操作。
# 高并发废片重做可能让同一套服装、同一动作的多个候选同时返回；不加锁时
# 两个线程可能同时选中同一个文件名，造成覆盖或记录指向错误。
ecommerce_archive_lock = threading.RLock()
# 高并发生图并不等于同时传输100张大图。上传和下载分别限流，远端任务可以保持高并发。
ecommerce_runninghub_upload_semaphore = threading.BoundedSemaphore(4)
ecommerce_candidate_download_semaphore = threading.BoundedSemaphore(6)

# OpenAI-HK GPT 图片是同步慢接口；放进本地后台池后，前端可以继续提交下一张。
GPT_IMAGE_JOB_MAX_WORKERS = int(os.environ.get('AI_GPT_IMAGE_JOB_WORKERS', '4') or 4)
gpt_image_job_executor = ThreadPoolExecutor(max_workers=max(1, GPT_IMAGE_JOB_MAX_WORKERS))
gpt_image_jobs = {}
gpt_image_jobs_lock = threading.RLock()

# DWPose 模型缓存（懒加载，首次调用时初始化）
_dwpose_model = None
_dwpose_lock = threading.Lock()

# 日志配置：控制台 + 轮转文件
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

# 文件日志：最大10MB，保留3个备份
file_handler = RotatingFileHandler(
    os.path.join(LOG_DIR, 'app.log'),
    maxBytes=10 * 1024 * 1024,
    backupCount=3,
    encoding='utf-8'
)
file_handler.setFormatter(logging.Formatter(
    '%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
))
file_handler.setLevel(logging.INFO)
# 只挂到 root；本模块 logger 默认向 root 传播。此前同时挂两处会把每条日志写两遍，
# 容易让人误以为同一付费任务提交了两次。
logging.getLogger().addHandler(file_handler)


def _disable_global_proxy_env():
    """默认清空系统代理环境变量，避免 requests 误走本机/公司代理导致 403。"""
    # 可通过环境变量显式允许保留系统代理（用于必须走代理的场景）
    keep_proxy = os.environ.get('AI_PROMPT_KEEP_SYSTEM_PROXY', '').strip().lower() in ('1', 'true', 'yes', 'on')
    if keep_proxy:
        logger.info('[net] 保留系统代理环境变量（AI_PROMPT_KEEP_SYSTEM_PROXY=1）')
        return
    proxy_keys = (
        'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
        'http_proxy', 'https_proxy', 'all_proxy',
    )
    removed = []
    for k in proxy_keys:
        if os.environ.pop(k, None) is not None:
            removed.append(k)
    # 明确直连本地地址，避免被代理接管
    os.environ['NO_PROXY'] = '127.0.0.1,localhost'
    os.environ['no_proxy'] = '127.0.0.1,localhost'
    if removed:
        logger.info(f"[net] 已清理系统代理变量: {', '.join(removed)}")
    else:
        logger.info('[net] 未检测到系统代理变量，保持直连模式')


_disable_global_proxy_env()

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
IMAGES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static', 'images')
BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backups')
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# DWPose 模型与缓存目录
DWPOSE_MODEL_DIR = os.path.join(BASE_DIR, 'models', 'dwpose')
DWPOSE_CACHE_DIR = os.path.join(IMAGES_DIR, 'dwpose_cache')
os.makedirs(DWPOSE_CACHE_DIR, exist_ok=True)

# 首次运行会从 HuggingFace 下载 ONNX（体积较大）。国内网络不稳定时可自行设置：
#   export HF_ENDPOINT=https://hf-mirror.com
#   export HF_HUB_DOWNLOAD_TIMEOUT=600
if os.environ.get('HF_HUB_DOWNLOAD_TIMEOUT') is None:
    os.environ['HF_HUB_DOWNLOAD_TIMEOUT'] = '600'
if os.environ.get('AI_PROMPT_USE_HF_MIRROR', '1').strip().lower() in ('1', 'true', 'yes', 'on'):
    os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')


def _clear_stale_dwpose_hf_locks(max_age_sec=1500):
    """移除 models/dwpose 下遗留的 huggingface_hub *.lock，避免进程中断后下载永久卡住。"""
    if not os.path.isdir(DWPOSE_MODEL_DIR):
        return
    now = time.time()
    for root, _, files in os.walk(DWPOSE_MODEL_DIR):
        for name in files:
            if not name.endswith('.lock'):
                continue
            lock_path = os.path.join(root, name)
            try:
                if now - os.path.getmtime(lock_path) > max_age_sec:
                    os.remove(lock_path)
                    logger.warning('[dwpose] 移除超时下载锁: %s', lock_path)
            except OSError:
                pass


def resolve_dwpose_model_file(model_name, filename, download_func):
    """优先使用软件目录内的 DWPose 模型；缺失时下载到软件目录。"""
    model_path = os.path.join(DWPOSE_MODEL_DIR, *model_name.split('/'), filename)
    if os.path.exists(model_path):
        return model_path

    os.makedirs(DWPOSE_MODEL_DIR, exist_ok=True)
    _clear_stale_dwpose_hf_locks(max_age_sec=60)
    try:
        return download_func(
            model_name,
            filename,
            cache_dir=DWPOSE_MODEL_DIR,
            use_symlinks=False
        )
    except Exception as exc:
        raise RuntimeError(
            f'DWPose 模型缺失且自动下载失败：{filename}。'
            f'请手动下载 yzd-v/DWPose/{filename} 放到 {model_path} 后重试。'
            f'原始错误：{exc}'
        ) from exc

# ========== 安全辅助函数 ==========

# 允许代理下载的图片域名白名单
ALLOWED_IMAGE_DOMAINS = {
    'runninghub.ai', 'www.runninghub.ai',
    'rh-images.xiaoyaoyou.com',
    # RunningHub 2026-07 起企业线路上传接口会返回该香港图片切换域名。
    # 只放行精确主机，不放行整个 xiaoyaoyou.com，避免扩大 SSRF 信任范围。
    'rh-hk-images-switch.xiaoyaoyou.com',
    'cos.ap-guangzhou.myqcloud.com',
    'cos.ap-beijing.myqcloud.com',
    'cos.ap-hongkong.myqcloud.com',
    'cos.ap-shanghai.myqcloud.com',
    'cos.ap-singapore.myqcloud.com',
    'openai-hk.com', 'api.openai-hk.com',
    'fal.media', 'v3.fal.media', 'storage.fal.media',
    'replicate.com', 'api.replicate.com',
    'pbxt.replicate.delivery',
    'pro.filesystem.site',
    'oss.filenest.top',
    'webstatic.aiproxy.vip',
    'aiproxy.vip',
}

# 允许代理 API 的 base_url 域名白名单
ALLOWED_API_DOMAINS = {
    'runninghub.ai', 'www.runninghub.ai',
    'openai-hk.com', 'api.openai-hk.com',
    'deepseek.com', 'api.deepseek.com',
    'bigmodel.cn', 'open.bigmodel.cn',
}

DEFAULT_RH_BASE_URL = 'https://www.runninghub.ai/openapi/v2'
DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'


def _normalize_runninghub_base_url(value):
    """Use the Global/AI endpoint for all new Standard Model API traffic.

    RunningHub announced the affected CN model endpoints will stop on
    2026-07-30. Old backups may still contain the CN base URL, so migrate the
    exact legacy standard-model address instead of silently continuing to use it.
    """
    base_url = str(value or DEFAULT_RH_BASE_URL).strip().rstrip('/')
    try:
        hostname = (urlparse(base_url).hostname or '').lower()
    except (TypeError, ValueError):
        hostname = ''
    if hostname in {'runninghub.cn', 'www.runninghub.cn'}:
        return DEFAULT_RH_BASE_URL
    return base_url


def _normalize_prompt_model(provider, value):
    """Migrate DeepSeek model aliases retired on 2026-07-24."""
    model = str(value or '').strip()
    if str(provider or '').strip().lower() == 'deepseek' and model in {
        '', 'deepseek-chat', 'deepseek-reasoner',
    }:
        return DEFAULT_DEEPSEEK_MODEL
    return model

# OpenAI-HK 备用域名（主域名解析异常时自动回退）
OAIHK_FALLBACK_BASE_URLS = [
    'https://openai-hk.com',
]

# 自更新允许的 GitHub release 域名
ALLOWED_UPDATE_DOMAINS = {'github.com', 'api.github.com', 'githubusercontent.com', 'objects.githubusercontent.com'}


def _validate_url(url, allowed_domains):
    """验证URL是否在允许的域名白名单内，防止SSRF攻击
    返回 (ok, error_or_none, resolved_ip_or_none)"""
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https'):
            return False, f"不允许的协议: {parsed.scheme}", None
        hostname = parsed.hostname
        if not hostname:
            return False, "URL缺少主机名", None
        host_lower = hostname.lower()
        allowed = any(host_lower == domain or host_lower.endswith('.' + domain) for domain in allowed_domains)
        if not allowed:
            return False, f"域名不在白名单中: {hostname}", None

        # 拒绝私有IP/链路本地地址，并缓存解析结果防止DNS重绑定
        resolved_ip = None
        try:
            addrinfos = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
            for family, _, _, _, sockaddr in addrinfos:
                addr = sockaddr[0]
                if isinstance(addr, bytes):
                    continue
                try:
                    ip_obj = ipaddress.ip_address(addr)
                    if ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_reserved or ip_obj.is_link_local or ip_obj.is_multicast:
                        # 部分 macOS 代理/加速器会把可信 CDN 域名解析到 198.18/15 这类本机代理地址。
                        # 域名已在白名单内时不拦截，但也不绑定该 IP，交给 requests 按原始域名访问。
                        continue
                    # 使用第一个有效的公网IP
                    if resolved_ip is None:
                        resolved_ip = addr
                except ValueError:
                    continue
        except socket.gaierror:
            pass  # 域名无法解析，让requests处理
        return True, None, resolved_ip
    except Exception as e:
        return False, f"URL解析失败: {e}", None


def _safe_http_request(method, url, allowed_domains, *, timeout=60, **kwargs):
    """先校验URL白名单+私网IP，再用绑定IP发起请求，防DNS重绑定SSRF"""
    ok, err, resolved_ip = _validate_url(url, allowed_domains)
    if not ok:
        raise ValueError(f"URL安全校验失败: {err}")
    if resolved_ip:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        original_host = parsed.hostname
        if parsed.port:
            replacement = f"{resolved_ip}:{parsed.port}"
        else:
            replacement = resolved_ip
        bound_url = url.replace(f"://{original_host}", f"://{replacement}", 1)
        headers = kwargs.pop('headers', {})
        headers['Host'] = original_host
        kwargs['headers'] = headers
        return _http_request(method, bound_url, timeout=timeout, **kwargs)
    return _http_request(method, url, timeout=timeout, **kwargs)


def _validate_base_path(path):
    """验证保存路径是否在允许的目录内，防止任意文件写入"""
    expanded = os.path.expanduser(path)
    real = os.path.realpath(expanded)
    # 允许的根目录：用户主目录和项目目录
    home = os.path.realpath(os.path.expanduser('~'))
    allowed_roots = [home, BASE_DIR]
    for root in allowed_roots:
        if real.startswith(root + os.sep) or real == root:
            return True, None
    return False, f"路径不在允许范围内: {path}"


def _safe_extract_zip(zf, extract_dir, max_size_mb=200, max_entries=1000):
    """安全解压ZIP文件，防止ZIP炸弹和ZipSlip"""
    total_size = 0
    entry_count = 0
    for info in zf.infolist():
        entry_count += 1
        if entry_count > max_entries:
            raise ValueError(f"ZIP条目数超过限制({max_entries})")
        # 防止ZipSlip：确保解压路径在目标目录内
        target_path = os.path.realpath(os.path.join(extract_dir, info.filename))
        if not target_path.startswith(os.path.realpath(extract_dir) + os.sep):
            raise ValueError(f"ZIP路径遍历: {info.filename}")
        # 累计未压缩大小
        total_size += info.file_size
        if total_size > max_size_mb * 1024 * 1024:
            raise ValueError(f"ZIP解压后大小超过限制({max_size_mb}MB)")
    zf.extractall(extract_dir)


def _to_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in ('1', 'true', 'yes', 'on', 'y')
    return default


def _http_request(method, url, *, disable_system_proxy=True, **kwargs):
    """统一HTTP请求入口：默认禁用系统代理，避免本地代理劫持导致403/隧道失败。"""
    if disable_system_proxy:
        with requests.Session() as sess:
            sess.trust_env = False
            return sess.request(method, url, **kwargs)
    return requests.request(method, url, **kwargs)


def _build_oaihk_base_candidates(primary_base_url):
    """构建 OpenAI-HK 请求域名候选（主域名优先，备用域名兜底）。"""
    candidates = []
    normalized_primary = (primary_base_url or '').strip().rstrip('/')
    if normalized_primary:
        candidates.append(normalized_primary)
    for fallback in OAIHK_FALLBACK_BASE_URLS:
        fb = fallback.strip().rstrip('/')
        if fb and fb not in candidates:
            candidates.append(fb)
    return candidates


def _is_dns_or_connect_error(exc):
    text = str(exc)
    markers = (
        'NameResolutionError',
        'Failed to resolve',
        'nodename nor servname provided',
        'Name or service not known',
        'Temporary failure in name resolution',
        'Max retries exceeded',
        'ConnectionError',
    )
    return any(m in text for m in markers)


def _oaihk_request_with_fallback(method, base_url, endpoint_path, *, disable_system_proxy=True, timeout=120, **kwargs):
    """OpenAI-HK 请求：主域名失败时自动切到备用域名重试。"""
    endpoint = (endpoint_path or '').lstrip('/')
    candidates = _build_oaihk_base_candidates(base_url)
    last_error = None
    for i, base in enumerate(candidates):
        url = f"{base}/{endpoint}" if endpoint else base
        try:
            if i > 0:
                logger.warning(f'[oaihk] 域名回退重试: {url}')
            return _http_request(method, url, timeout=timeout, disable_system_proxy=disable_system_proxy, **kwargs)
        except Exception as e:
            last_error = e
            # 仅对 DNS/连接类异常做域名回退，避免误掩盖业务错误
            if i < len(candidates) - 1 and _is_dns_or_connect_error(e):
                logger.warning(f'[oaihk] 请求失败，准备切换备用域名: {url}, error={e}')
                continue
            raise
    if last_error:
        raise last_error
    raise RuntimeError('oaihk request failed without candidates')


def _local_only(f):
    """仅允许本地访问的装饰器"""
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        client_ip = request.remote_addr or ''
        if client_ip.startswith('::ffff:'):
            client_ip = client_ip.split('::ffff:')[1]
        if client_ip not in ('127.0.0.1', '::1', 'localhost'):
            return jsonify({"error": "仅限本地访问"}), 403
        return f(*args, **kwargs)
    return decorated


def ensure_data_dir():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(IMAGES_DIR, exist_ok=True)
    os.makedirs(BACKUP_DIR, exist_ok=True)


def load_json(filename):
    """安全加载 JSON，支持损坏时自动从备份恢复"""
    filepath = os.path.join(DATA_DIR, filename)
    if not os.path.exists(filepath):
        return None
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        # 不再在读取时备份，备份逻辑移到 save_json 中
        return data
    except (json.JSONDecodeError, ValueError) as e:
        logger.error(f"JSON 文件损坏: {filename}, 错误: {e}")
        backup_path = filepath + '.bak'
        if os.path.exists(backup_path):
            try:
                with open(backup_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                logger.info(f"从备份恢复成功: {filename}")
                shutil.copy2(backup_path, filepath)
                return data
            except (json.JSONDecodeError, ValueError):
                logger.error(f"备份文件也损坏: {filename}")
        return None
    except Exception as e:
        logger.error(f"加载 JSON 失败: {filename}, 错误: {e}")
        return None


def save_json(filename, data):
    """原子写入 JSON：先备份旧文件，再写临时文件，再原子替换"""
    filepath = os.path.join(DATA_DIR, filename)
    dir_path = os.path.dirname(filepath)

    # Safety guard: prevent test processes from overwriting production ecommerce
    # data. Only blocks if NEW batches with temp-directory paths are being added
    # (compared against the existing file). Existing temp-path batches in the
    # file are stripped rather than blocking all saves — this avoids a single
    # legacy test batch from paralyzing all write operations.
    if filename == ECOMMERCE_DATA_FILE and isinstance(data, dict):
        real_data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
        real_filepath = os.path.join(real_data_dir, filename)
        if os.path.realpath(filepath) == os.path.realpath(real_filepath):
            def _is_temp_path(p):
                p = p or ''
                return '/var/folders/' in p or '/tmp/' in p or p.startswith('/private/tmp/')

            # Load existing batch IDs that already have temp paths (known contamination)
            existing_temp_ids = set()
            if os.path.exists(filepath):
                try:
                    with open(filepath, 'r', encoding='utf-8') as ef:
                        old = json.load(ef)
                    for b in (old.get('batches') or []):
                        if _is_temp_path(b.get('output_path') or ''):
                            existing_temp_ids.add(b.get('id'))
                except Exception:
                    pass

            # Check for NEW temp-path batches (not in existing file)
            new_temp_batches = [
                b for b in (data.get('batches') or [])
                if _is_temp_path(b.get('output_path') or '') and b.get('id') not in existing_temp_ids
            ]
            if new_temp_batches:
                logger.error(
                    f'[save_json] 拒绝写入新测试数据到真实数据文件: '
                    f'{[b.get("id") for b in new_temp_batches]}'
                )
                return

            # Strip existing temp-path batches instead of blocking the save
            if existing_temp_ids:
                before = len(data.get('batches') or [])
                data['batches'] = [
                    b for b in (data.get('batches') or [])
                    if b.get('id') not in existing_temp_ids
                ]
                removed = before - len(data['batches'])
                if removed:
                    logger.warning(
                        f'[save_json] 清理了 {removed} 个引用临时目录的旧批次: {existing_temp_ids}'
                    )

    # 写入前备份当前文件（如果存在）
    if os.path.exists(filepath):
        backup_path = filepath + '.bak'
        try:
            shutil.copy2(filepath, backup_path)
        except Exception:
            pass

    fd, tmp_path = tempfile.mkstemp(dir=dir_path, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, filepath)  # 原子操作
    except Exception:
        # 写入失败时清理临时文件
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def gen_id(prefix='id'):
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _move_path_to_trash(path):
    """Move a file/folder to the macOS Trash instead of deleting permanently."""
    real = os.path.realpath(os.path.expanduser(path))
    if not os.path.exists(real):
        raise FileNotFoundError(real)
    escaped = real.replace('\\', '\\\\').replace('"', '\\"')
    script = f'tell application "Finder" to move POSIX file "{escaped}" to trash'
    subprocess.run(['osascript', '-e', script], check=True, timeout=30)


def _move_paths_to_trash(paths):
    """Batch move files/folders to Trash to avoid repeated Finder prompts/sounds."""
    cleaned = []
    for p in paths or []:
        real = os.path.realpath(os.path.expanduser(p))
        if os.path.exists(real):
            cleaned.append(real)
    if not cleaned:
        return
    refs = []
    for p in cleaned:
        escaped = p.replace('\\', '\\\\').replace('"', '\\"')
        refs.append(f'POSIX file "{escaped}"')
    script = f'tell application "Finder" to move {{{", ".join(refs)}}} to trash'
    subprocess.run(['osascript', '-e', script], check=True, timeout=60)


def _path_size_kb(path):
    if os.path.isfile(path):
        return os.path.getsize(path) / 1024
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            fp = os.path.join(root, name)
            try:
                total += os.path.getsize(fp)
            except OSError:
                pass
    return total / 1024


def _file_sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()


def _ensure_default_subcategory(cat):
    subs = cat.setdefault('subcategories', [])
    if not subs:
        subs.append({"id": gen_id('sub'), "name": "默认", "items": []})
    return subs[0]


def _ensure_library_category(lib_data, cat_name):
    categories = lib_data.setdefault('categories', [])
    for c in categories:
        if c.get('name') == cat_name:
            return c
    new_cat = {"id": gen_id('lib'), "name": cat_name, "subcategories": []}
    categories.append(new_cat)
    return new_cat


def _build_category_hash_index(lib_data):
    """构建同分类图片hash索引：{cat_name: set(hash)}"""
    idx = {}
    for cat in lib_data.get('categories', []):
        cat_name = cat.get('name', '')
        if not cat_name:
            continue
        idx.setdefault(cat_name, set())
        for sub in cat.get('subcategories', []):
            for item in sub.get('items', []):
                img = item.get('image', '')
                if isinstance(img, str) and img.startswith('/static/images/'):
                    img_name = img.replace('/static/images/', '')
                    img_path = os.path.join(IMAGES_DIR, img_name)
                    if os.path.exists(img_path):
                        try:
                            idx[cat_name].add(_file_sha256(img_path))
                        except Exception:
                            pass
    return idx


def _supplement_library_from_image_presets():
    """将图生图预设中的图片自动补入素材库（同分类+同hash去重），加锁防并发写入损坏"""
    with data_lock:
        presets_data = load_json('image_presets.json') or {"presets": []}
        if not presets_data.get('presets'):
            return {"added": 0, "skipped_same_hash": 0}

        lib_data = load_json('image_library.json') or {"categories": []}
        hash_idx = _build_category_hash_index(lib_data)
        added = 0
        skipped = 0

        for preset in presets_data.get('presets', []):
            for slot in preset.get('images', []):
                img_url = (slot.get('path') or '').strip()
                if not img_url.startswith('/static/images/'):
                    continue
                img_name = img_url.replace('/static/images/', '')
                img_path = os.path.join(IMAGES_DIR, img_name)
                if not os.path.exists(img_path):
                    continue

                cat_name = (slot.get('label') or '导入补全').strip() or '导入补全'
                item_name = (slot.get('label') or os.path.splitext(img_name)[0]).strip() or os.path.splitext(img_name)[0]

                try:
                    img_hash = _file_sha256(img_path)
                except Exception:
                    continue

                cat_hashes = hash_idx.setdefault(cat_name, set())
                # A+B策略：仅同分类+同hash去重；跨分类允许同图共存
                if img_hash in cat_hashes:
                    skipped += 1
                    continue

                cat = _ensure_library_category(lib_data, cat_name)
                sub = _ensure_default_subcategory(cat)
                sub.setdefault('items', []).append({
                    "id": gen_id('libitem'),
                    "name": item_name,
                    "image": img_url
                })
                cat_hashes.add(img_hash)
                added += 1

        save_json('image_library.json', lib_data)
        return {"added": added, "skipped_same_hash": skipped}


# ========== 页面路由 ==========

@app.route('/')
def index():
    return render_template('index.html', version=int(time.time()))


@app.route('/static/<path:filename>')
def static_files(filename):
    return send_from_directory(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static'), filename)


# ========== 分类 API ==========

@app.route('/api/categories', methods=['GET'])
def get_categories():
    data = load_json('categories.json')
    if data is None:
        return jsonify({"categories": []})
    return jsonify(data)


@app.route('/api/categories', methods=['POST'])
def create_category():
    body = request.get_json(silent=True) or {}
    name = body.get('name', '').strip()
    selection_type = body.get('selection_type', 'single')
    if not name:
        return jsonify({"error": "分类名称不能为空"}), 400

    with data_lock:
        data = load_json('categories.json')
        if data is None:
            data = {"categories": []}

        cat = {
            "id": gen_id('cat'),
            "name": name,
            "selection_type": selection_type,
            "items": []
        }
        data['categories'].append(cat)
        save_json('categories.json', data)

    logger.info(f"新增大分类: {name}")
    return jsonify(cat), 201


@app.route('/api/categories/<cat_id>', methods=['PUT'])
def update_category(cat_id):
    body = request.get_json()
    name = body.get('name', '').strip()
    selection_type = body.get('selection_type')

    if selection_type is not None:
        if selection_type not in ('single', 'multi'):
            return jsonify({"error": "selection_type 仅支持 single/multi"}), 400

    with data_lock:
        data = load_json('categories.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for cat in data['categories']:
            if cat['id'] == cat_id:
                if name:
                    cat['name'] = name
                if selection_type is not None:
                    cat['selection_type'] = selection_type
                save_json('categories.json', data)
                logger.info(f"更新大分类: {cat_id} -> {name}")
                return jsonify(cat)

    return jsonify({"error": "分类不存在"}), 404


@app.route('/api/categories/<cat_id>', methods=['DELETE'])
def delete_category(cat_id):
    with data_lock:
        data = load_json('categories.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        data['categories'] = [c for c in data['categories'] if c['id'] != cat_id]
        save_json('categories.json', data)
        _remove_from_order('category', cat_id)

    logger.info(f"删除大分类: {cat_id}")
    return jsonify({"success": True})


# ========== 排序 API ==========

def _load_order():
    data = load_json('category_order.json')
    if data is None:
        return {"order": []}
    return data


def _save_order(data):
    save_json('category_order.json', data)


def _remove_from_order(item_type, item_id):
    with data_lock:
        order_data = _load_order()
        order_data['order'] = [o for o in order_data['order'] if not (o.get('type') == item_type and o.get('id') == item_id)]
        _save_order(order_data)


@app.route('/api/category-order', methods=['GET'])
def get_category_order():
    data = _load_order()
    return jsonify(data)


@app.route('/api/category-order', methods=['PUT'])
def update_category_order():
    body = request.get_json()
    order = body.get('order', [])
    with data_lock:
        _save_order({"order": order})
    logger.info(f"更新分类排序: {len(order)} 项")
    return jsonify({"success": True})


# ========== 条目 API ==========

@app.route('/api/categories/<cat_id>/items', methods=['POST'])
def create_item(cat_id):
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "条目名称不能为空"}), 400

    with data_lock:
        data = load_json('categories.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for cat in data['categories']:
            if cat['id'] == cat_id:
                item = {
                    "id": gen_id('item'),
                    "name": name
                }
                cat['items'].append(item)
                save_json('categories.json', data)
                logger.info(f"新增条目: {name} (分类: {cat['name']})")
                return jsonify(item), 201

    return jsonify({"error": "分类不存在"}), 404


@app.route('/api/categories/<cat_id>/items/<item_id>', methods=['PUT'])
def update_item(cat_id, item_id):
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "条目名称不能为空"}), 400

    with data_lock:
        data = load_json('categories.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for cat in data['categories']:
            if cat['id'] == cat_id:
                for item in cat['items']:
                    if item['id'] == item_id:
                        item['name'] = name
                        save_json('categories.json', data)
                        logger.info(f"更新条目: {item_id} -> {name}")
                        return jsonify(item)

    return jsonify({"error": "条目不存在"}), 404


@app.route('/api/categories/<cat_id>/items/<item_id>', methods=['DELETE'])
def delete_item(cat_id, item_id):
    with data_lock:
        data = load_json('categories.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for cat in data['categories']:
            if cat['id'] == cat_id:
                cat['items'] = [i for i in cat['items'] if i['id'] != item_id]
                save_json('categories.json', data)
                logger.info(f"删除条目: {item_id}")
                return jsonify({"success": True})

    return jsonify({"error": "分类不存在"}), 404


# ========== 前缀 API ==========

@app.route('/api/prefixes', methods=['GET'])
def get_prefixes():
    data = load_json('prefixes.json')
    if data is None:
        return jsonify({"prefixes": []})
    return jsonify(data)


@app.route('/api/prefixes', methods=['POST'])
def create_prefix():
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "前缀内容不能为空"}), 400

    with data_lock:
        data = load_json('prefixes.json')
        if data is None:
            data = {"prefixes": []}

        prefix = {"id": gen_id('prefix'), "name": name}
        data['prefixes'].append(prefix)
        save_json('prefixes.json', data)

    logger.info(f"新增前缀: {name}")
    return jsonify(prefix), 201


@app.route('/api/prefixes/<prefix_id>', methods=['PUT'])
def update_prefix(prefix_id):
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "前缀内容不能为空"}), 400

    with data_lock:
        data = load_json('prefixes.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for p in data['prefixes']:
            if p['id'] == prefix_id:
                p['name'] = name
                save_json('prefixes.json', data)
                logger.info(f"更新前缀: {prefix_id} -> {name}")
                return jsonify(p)

    return jsonify({"error": "前缀不存在"}), 404


@app.route('/api/prefixes/<prefix_id>', methods=['DELETE'])
def delete_prefix(prefix_id):
    with data_lock:
        data = load_json('prefixes.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        data['prefixes'] = [p for p in data['prefixes'] if p['id'] != prefix_id]
        save_json('prefixes.json', data)
        _remove_from_order('prefix', prefix_id)

    logger.info(f"删除前缀: {prefix_id}")
    return jsonify({"success": True})


# ========== 后缀 API ==========

@app.route('/api/suffixes', methods=['GET'])
def get_suffixes():
    data = load_json('suffixes.json')
    if data is None:
        return jsonify({"suffixes": []})
    return jsonify(data)


@app.route('/api/suffixes', methods=['POST'])
def create_suffix():
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "后缀内容不能为空"}), 400

    with data_lock:
        data = load_json('suffixes.json')
        if data is None:
            data = {"suffixes": []}

        suffix = {"id": gen_id('suffix'), "name": name}
        data['suffixes'].append(suffix)
        save_json('suffixes.json', data)

    logger.info(f"新增后缀: {name}")
    return jsonify(suffix), 201


@app.route('/api/suffixes/<suffix_id>', methods=['PUT'])
def update_suffix(suffix_id):
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "后缀内容不能为空"}), 400

    with data_lock:
        data = load_json('suffixes.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for s in data['suffixes']:
            if s['id'] == suffix_id:
                s['name'] = name
                save_json('suffixes.json', data)
                logger.info(f"更新后缀: {suffix_id} -> {name}")
                return jsonify(s)

    return jsonify({"error": "后缀不存在"}), 404


@app.route('/api/suffixes/<suffix_id>', methods=['DELETE'])
def delete_suffix(suffix_id):
    with data_lock:
        data = load_json('suffixes.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        data['suffixes'] = [s for s in data['suffixes'] if s['id'] != suffix_id]
        save_json('suffixes.json', data)
        _remove_from_order('suffix', suffix_id)

    logger.info(f"删除后缀: {suffix_id}")
    return jsonify({"success": True})


# ========== 预设分类标签 API ==========

@app.route('/api/preset-tags', methods=['GET'])
def get_preset_tags():
    data = load_json('preset_tags.json')
    if data is None:
        default_tags = ['肖像', '写真', '日系写真', '纯欲写真', '私房写真', '外景写真', '樱花写真', '新中式', '古风', '旗袍', '韩杂', '日杂', '杂志', '氛围感肖像', '胶片写真', '暗黑写真', '欧美肖像', '商业写真', '复古写真', '纪实写真']
        data = {"tags": default_tags}
        save_json('preset_tags.json', data)
    return jsonify(data)


@app.route('/api/preset-tags', methods=['PUT'])
def update_preset_tags():
    body = request.get_json()
    tags = body.get('tags', [])
    with data_lock:
        save_json('preset_tags.json', {"tags": tags})
    logger.info(f"更新预设分类标签: {len(tags)} 个")
    return jsonify({"success": True})


# ========== 前缀模板 API ==========

@app.route('/api/prefix-templates', methods=['GET'])
def get_prefix_templates():
    data = load_json('prefix_templates.json')
    if data is None:
        data = {"templates": ["请参考", "请模仿", "请替换", "请融合"]}
        save_json('prefix_templates.json', data)
    return jsonify(data)


@app.route('/api/prefix-templates', methods=['PUT'])
def update_prefix_templates():
    body = request.get_json()
    templates = body.get('templates', [])
    with data_lock:
        save_json('prefix_templates.json', {"templates": templates})
    logger.info(f"更新前缀模板: {len(templates)} 个")
    return jsonify({"success": True})


# ========== 提示词模板（前缀/后缀）API ==========

@app.route('/api/prompt-templates', methods=['GET'])
def get_prompt_templates():
    """获取图生图提示词前缀/后缀模板及选中状态"""
    data = load_json('prompt_templates.json')
    if data is None:
        data = {
            "prefixes": [],
            "suffixes": [],
            "selectedPrefixIds": [],
            "selectedSuffixIds": []
        }
    # 确保结构完整
    if 'prefixes' not in data: data['prefixes'] = []
    if 'suffixes' not in data: data['suffixes'] = []
    if 'selectedPrefixIds' not in data: data['selectedPrefixIds'] = []
    if 'selectedSuffixIds' not in data: data['selectedSuffixIds'] = []
    return jsonify(data)


@app.route('/api/prompt-templates', methods=['PUT'])
def update_prompt_templates():
    """保存图生图提示词前缀/后缀模板及选中状态"""
    body = request.get_json()
    with data_lock:
        save_json('prompt_templates.json', {
            "prefixes": body.get('prefixes', []),
            "suffixes": body.get('suffixes', []),
            "selectedPrefixIds": body.get('selectedPrefixIds', []),
            "selectedSuffixIds": body.get('selectedSuffixIds', [])
        })
    logger.info(f"更新提示词模板: {len(body.get('prefixes', []))}个前缀, {len(body.get('suffixes', []))}个后缀")
    return jsonify({"success": True})


# ========== 提示词预设 API（图生图中文提示词快捷预设） ==========

@app.route('/api/prompt-presets', methods=['GET'])
def get_prompt_presets():
    """获取提示词预设列表"""
    data = load_json('prompt_presets.json')
    if data is None:
        data = {"presets": [], "groups": []}
    if 'presets' not in data:
        data['presets'] = []
    if 'groups' not in data:
        data['groups'] = []
    return jsonify(data)


@app.route('/api/prompt-presets', methods=['PUT'])
def update_prompt_presets():
    """保存提示词预设列表"""
    body = request.get_json(silent=True) or {}
    with data_lock:
        save_json('prompt_presets.json', {
            "presets": body.get('presets', []),
            "groups": body.get('groups', [])
        })
    logger.info(f"更新提示词预设: {len(body.get('presets', []))}个, 分组{len(body.get('groups', []))}个")
    return jsonify({"success": True})


# ========== 预设 API ==========

@app.route('/api/presets', methods=['GET'])
def get_presets():
    data = load_json('presets.json')
    if data is None:
        return jsonify({"presets": []})
    return jsonify(data)


@app.route('/api/presets', methods=['POST'])
def create_preset():
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "预设名称不能为空"}), 400

    with data_lock:
        data = load_json('presets.json')
        if data is None:
            data = {"presets": []}

        now = time.strftime('%Y-%m-%d %H:%M:%S')
        preset = {
            "id": gen_id('preset'),
            "name": name,
            "cover_image": body.get('cover_image', ''),
            "effect_image": body.get('effect_image', ''),
            "prompt_text": body.get('prompt_text', ''),
            "tags": body.get('tags', []),
            "selected_prefixes": body.get('selected_prefixes', []),
            "selected_items": body.get('selected_items', []),
            "selected_suffixes": body.get('selected_suffixes', []),
            "created_at": now,
            "updated_at": now
        }
        data['presets'].append(preset)
        save_json('presets.json', data)

    logger.info(f"新增预设: {name}")
    return jsonify(preset), 201


@app.route('/api/presets/<preset_id>', methods=['PUT'])
def update_preset(preset_id):
    body = request.get_json()
    with data_lock:
        data = load_json('presets.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for p in data['presets']:
            if p['id'] == preset_id:
                if 'name' in body:
                    p['name'] = body['name'].strip()
                if 'cover_image' in body:
                    p['cover_image'] = body['cover_image']
                if 'effect_image' in body:
                    p['effect_image'] = body['effect_image']
                if 'prompt_text' in body:
                    p['prompt_text'] = body['prompt_text']
                if 'tags' in body:
                    p['tags'] = body['tags']
                if 'selected_prefixes' in body:
                    p['selected_prefixes'] = body['selected_prefixes']
                if 'selected_items' in body:
                    p['selected_items'] = body['selected_items']
                if 'selected_suffixes' in body:
                    p['selected_suffixes'] = body['selected_suffixes']
                p['updated_at'] = time.strftime('%Y-%m-%d %H:%M:%S')
                save_json('presets.json', data)
                logger.info(f"更新预设: {preset_id}")
                return jsonify(p)

    return jsonify({"error": "预设不存在"}), 404


@app.route('/api/presets/<preset_id>', methods=['DELETE'])
def delete_preset(preset_id):
    with data_lock:
        data = load_json('presets.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        data['presets'] = [p for p in data['presets'] if p['id'] != preset_id]
        save_json('presets.json', data)

    logger.info(f"删除预设: {preset_id}")
    return jsonify({"success": True})


# ========== 图片上传 ==========


@app.route('/api/health', methods=['GET'])
def health_check():
    return jsonify({"ok": True}), 200




def get_upload_settings():
    """从model_config.json读取上传压缩设置，短边仅允许4档预设值"""
    config = load_json('model_config.json') or {}
    try:
        short_edge = int(config.get('upload_short_edge', 1536))
    except (ValueError, TypeError):
        short_edge = 1536
    # 仅允许4档预设值
    allowed = {768, 1536, 2304, 3072}
    if short_edge not in allowed:
        short_edge = 1536
    if short_edge <= 0:
        short_edge = 1536
    return short_edge, 90


def convert_to_jpg(image_bytes):
    """将任意格式的图片字节转为JPG格式，保持像素和尺寸不变。
    返回 (jpg_bytes, '.jpg')，转换失败时返回原数据。"""
    try:
        img = Image.open(io.BytesIO(image_bytes))
        img = ImageOps.exif_transpose(img)
        # RGBA/P/LA 等模式需转为 RGB
        if img.mode in ('RGBA', 'P', 'LA', 'L', 'PA', 'I', 'F'):
            if img.mode == 'RGBA':
                background = Image.new('RGB', img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[3])
                img = background
            else:
                img = img.convert('RGB')
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=95, optimize=True)
        return buf.getvalue(), '.jpg'
    except Exception as e:
        logger.warning(f"JPG转换失败，保留原格式: {e}")
        return image_bytes, None


def _parse_size_text(size_text):
    try:
        s = (size_text or '').strip().lower()
        if 'x' not in s:
            return None
        w_str, h_str = s.split('x', 1)
        w = int(w_str)
        h = int(h_str)
        if w <= 0 or h <= 0:
            return None
        return w, h
    except Exception:
        return None


def _inspect_gpt_result_size(result, target_size_text):
    """记录 GPT 上游返回图的真实尺寸，不用本地放大伪装成请求尺寸。"""
    target = _parse_size_text(target_size_text)
    target_w, target_h = target if target else (None, None)
    data_list = result.get('data')
    if not isinstance(data_list, list):
        return result

    checks = []
    has_mismatch = False

    for idx, item in enumerate(data_list):
        if not isinstance(item, dict):
            continue
        raw_bytes = None

        # 优先使用已有b64，避免额外网络下载
        b64_json = item.get('b64_json')
        if isinstance(b64_json, str) and b64_json:
            try:
                raw_bytes = base64.b64decode(b64_json)
            except Exception:
                raw_bytes = None

        # 没有b64时，尝试下载URL
        if raw_bytes is None and item.get('url'):
            image_url = str(item.get('url') or '').strip()
            ok, err, _ = _validate_url(image_url, ALLOWED_IMAGE_DOMAINS)
            if ok:
                try:
                    resp = _http_request('GET', image_url, timeout=120, stream=True, disable_system_proxy=True)
                    if resp.status_code == 200:
                        buf = io.BytesIO()
                        max_size = 30 * 1024 * 1024
                        for chunk in resp.iter_content(chunk_size=8192):
                            buf.write(chunk)
                            if buf.tell() > max_size:
                                raw_bytes = None
                                break
                        else:
                            raw_bytes = buf.getvalue()
                except Exception as e:
                    logger.warning(f'[gpt-image] 结果图下载失败(尺寸检查跳过): {e}')
            else:
                logger.warning(f'[gpt-image] 结果图URL被安全拦截(尺寸检查跳过): {err}')

        if raw_bytes is None:
            continue

        try:
            img = Image.open(io.BytesIO(raw_bytes))
            img = ImageOps.exif_transpose(img)
            cur_w, cur_h = img.size
            matches = None if target is None else (cur_w == target_w and cur_h == target_h)
            checks.append({
                'index': idx,
                'actual_size': f'{cur_w}x{cur_h}',
                'requested_size': str(target_size_text or 'auto'),
                'matches_request': matches,
            })
            if matches is False:
                has_mismatch = True
                logger.warning(
                    f'[gpt-image] 上游真实返回{cur_w}x{cur_h}，与请求'
                    f'{target_w}x{target_h}不一致；保留原图，不执行本地放大'
                )
        except Exception as e:
            logger.warning(f'[gpt-image] 尺寸检查失败(跳过): {e}')

    if checks:
        result['sample_factory_size_check'] = checks
        result['sample_factory_size_mismatch'] = has_mismatch
    return result


@app.route('/api/convert-download', methods=['POST'])
def convert_download():
    """将任意URL的图片转为JPG后作为附件下载，确保所有下载都是JPG格式"""
    body = request.get_json(silent=True) or {}
    image_url = body.get('url', '')
    filename = body.get('filename', 'AI生图.jpg')

    if not image_url:
        return jsonify({"error": "缺少图片URL"}), 400

    # 处理本地路径（/static/images/xxx.jpg）
    if image_url.startswith('/'):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        local_path = os.path.join(base_dir, image_url.lstrip('/'))
        if not os.path.realpath(local_path).startswith(os.path.realpath(base_dir)):
            return jsonify({"error": "路径不允许"}), 403
        if not os.path.exists(local_path):
            return jsonify({"error": "文件不存在"}), 404
        file_size = os.path.getsize(local_path)
        if file_size > 30 * 1024 * 1024:
            return jsonify({"error": "本地图片超过30MB限制"}), 413
        with open(local_path, 'rb') as f:
            data = f.read()
    else:
        # 远程URL：SSRF防护
        ok, err, _ = _validate_url(image_url, ALLOWED_IMAGE_DOMAINS)
        if not ok:
            return jsonify({"error": f"URL不允许: {err}"}), 403
        try:
            resp = requests.get(image_url, timeout=60, stream=True)
            if resp.status_code != 200:
                return jsonify({"error": f"下载失败: HTTP {resp.status_code}"}), 502
            max_size = 30 * 1024 * 1024
            buf = io.BytesIO()
            for chunk in resp.iter_content(chunk_size=8192):
                buf.write(chunk)
                if buf.tell() > max_size:
                    return jsonify({"error": "图片超过30MB限制"}), 413
            data = buf.getvalue()
        except requests.exceptions.Timeout:
            return jsonify({"error": "下载超时"}), 504

    # 转为JPG
    jpg_data, jpg_ext = convert_to_jpg(data)
    if jpg_ext:
        data = jpg_data
        name_part, ext_part = os.path.splitext(filename)
        if ext_part.lower() not in ('.jpg', '.jpeg'):
            filename = name_part + '.jpg'

    from io import BytesIO
    return send_file(
        BytesIO(data),
        mimetype='image/jpeg',
        as_attachment=True,
        download_name=filename
    )


def compress_image(file_stream, ext, aspect_ratio=None):
    """统一裁剪、缩放和压缩图片。

    aspect_ratio='adaptive' 时按原图方向自动居中裁为 3:4 或 4:3；
    前端手动裁剪后的图片不传该参数，仅执行缩放和压缩。
    返回 (buf, '.jpg', warning) 其中warning为上采样警告字符串或None"""
    short_edge_target, _ = get_upload_settings()
    warning = None

    img = Image.open(file_stream)
    img = ImageOps.exif_transpose(img)

    if aspect_ratio == 'adaptive':
        auto_ratio = '4:3' if img.width >= img.height else '3:4'
        img = _smart_crop_to_ratio(img, auto_ratio)
    elif isinstance(aspect_ratio, str) and ':' in aspect_ratio:
        img = _smart_crop_to_ratio(img, aspect_ratio)

    w, h = img.size

    # 超大图保护：如果像素总数超过 4000万像素（如8000x10000=8000万），先缩小到合理尺寸
    # 防止内存溢出和后续处理过慢
    MAX_PIXELS = 40_000_000
    if w * h > MAX_PIXELS:
        scale = (MAX_PIXELS / (w * h)) ** 0.5
        w = int(w * scale)
        h = int(h * scale)
        img = img.resize((w, h), Image.LANCZOS)
        warning = f'原图过大已自动缩小至{w}×{h}'

    # 统一缩放：短边缩放到配置值（前端已保证3:4比例，无需再裁剪）
    short_edge = min(w, h)
    if short_edge != short_edge_target:
        scale = short_edge_target / short_edge
        new_w = int(w * scale)
        new_h = int(h * scale)
        img = img.resize((new_w, new_h), Image.LANCZOS)
        if short_edge < short_edge_target:
            warning = f'图片短边({short_edge}px)不足预设({short_edge_target}px)，已上采样放大，可能影响画质'

    # 统一转为 JPG（非RGB模式均需转换）
    if img.mode != 'RGB':
        img = img.convert('RGB')

    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=90, optimize=True)

    # 如果文件 > 2MB，逐步降低质量直到 < 2MB
    quality = 90
    while buf.tell() > 2 * 1024 * 1024 and quality > 60:
        quality -= 10
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=quality, optimize=True)

    # 如果质量压缩到 60 仍超过 2MB，逐步缩小分辨率
    resize_attempts = 0
    while buf.tell() > 2 * 1024 * 1024 and resize_attempts < 10:
        w, h = img.size
        if w <= 200 or h <= 200:
            break
        img = img.resize((int(w * 0.8), int(h * 0.8)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=quality, optimize=True)
        resize_attempts += 1

    buf.seek(0)
    return buf, '.jpg', warning


def _smart_crop_to_ratio(img, aspect_ratio='3:4', tolerance=0.02):
    """智能裁剪：仅在图片比例与目标比例偏差超过容差时才裁剪，否则保留100%画面"""
    w, h = img.size
    parts = aspect_ratio.split(':')
    if len(parts) != 2:
        return img
    rw, rh = int(parts[0]), int(parts[1])
    if rh == 0 or h == 0:
        return img
    target_ratio = rw / rh
    current_ratio = w / h
    # 容差检查：偏差在2%以内不裁剪
    if abs(current_ratio - target_ratio) / target_ratio < tolerance:
        return img
    # 偏差超过容差，居中裁剪
    if current_ratio > target_ratio:
        new_w = int(h * target_ratio)
        left = (w - new_w) // 2
        img = img.crop((left, 0, left + new_w, h))
    elif current_ratio < target_ratio:
        new_h = int(w / target_ratio)
        top = (h - new_h) // 2
        img = img.crop((0, top, w, top + new_h))
    return img


@app.route('/api/upload-image', methods=['POST'])
def upload_image():
    if 'file' not in request.files:
        return jsonify({"error": "没有上传文件"}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({"error": "文件名为空"}), 400

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ['.jpg', '.jpeg', '.png', '.webp']:
        return jsonify({"error": "仅支持 JPG/PNG/WEBP 格式"}), 400

    try:
        config = load_json('model_config.json') or {}
        preserve_original = _to_bool(request.form.get('preserve_original'), False) or config.get('upload_mode') == 'original'
        if preserve_original:
            raw_bytes = file.read()
            if not raw_bytes:
                return jsonify({"error": "上传文件为空"}), 400
            # 解码校验，拒绝伪装扩展名的非图片文件；保存原始字节以保持像素尺寸、格式与元数据。
            Image.open(io.BytesIO(raw_bytes)).verify()
            filename = f"{gen_id('img')}{ext}"
            filepath = os.path.join(IMAGES_DIR, filename)
            with open(filepath, 'wb') as f:
                f.write(raw_bytes)
            logger.info(f"[upload] 原图上传成功: {filename}, 大小: {len(raw_bytes)//1024}KB, 不裁剪不缩放")
            return jsonify({"url": f"/static/images/{filename}", "preserved_original": True}), 201

        auto_crop = _to_bool(request.form.get('auto_crop'), False)
        with image_upload_processing_semaphore:
            compressed, final_ext, warning = compress_image(
                file.stream,
                ext,
                aspect_ratio='adaptive' if auto_crop else None,
            )
        filename = f"{gen_id('img')}{final_ext}"
        filepath = os.path.join(IMAGES_DIR, filename)
        with open(filepath, 'wb') as f:
            f.write(compressed.read())
        file_size = os.path.getsize(filepath)
        short_edge_target, _ = get_upload_settings()
        logger.info(f"[upload] 图片上传成功: {filename}, 大小: {file_size//1024}KB, 短边={short_edge_target}px")
        result = {"url": f"/static/images/{filename}"}
        if auto_crop:
            with Image.open(filepath) as saved_img:
                result.update({
                    "auto_cropped": True,
                    "crop_ratio": "4:3" if saved_img.width >= saved_img.height else "3:4",
                    "width": saved_img.width,
                    "height": saved_img.height,
                })
        if warning:
            result["warning"] = warning
        return jsonify(result), 201
    except Exception as e:
        # 压缩失败时回退到原始保存
        file.seek(0)
        filename = f"{gen_id('img')}{ext}"
        filepath = os.path.join(IMAGES_DIR, filename)
        file.save(filepath)
        logger.warning(f"[upload] 图片压缩失败,原始保存: {filename}, 错误: {e}")
        return jsonify({"url": f"/static/images/{filename}"}), 201


# ========== 模型配置 API ==========

def _mask_api_key(key):
    """遮蔽API密钥，只显示前2位和后2位"""
    if not key or len(key) <= 4:
        return '****' if key else ''
    return key[:2] + '****' + key[-2:]


@app.route('/api/model-config', methods=['GET'])
def get_model_config():
    data = load_json('model_config.json')
    if data is None:
        data = {
            "provider": "deepseek",
            "api_key": "",
            "base_url": "",
            "model_name": "",
            "timeout_ms": 30000,
            "retry_count": 2
        }
    # 旧备份/旧配置读取后立即迁移，设置页和后续请求都只看到新域名。
    old_rh_base_url = data.get('rh_base_url')
    normalized_rh_base_url = _normalize_runninghub_base_url(old_rh_base_url)
    old_model_name = data.get('model_name')
    normalized_model_name = _normalize_prompt_model(data.get('provider'), old_model_name)
    if normalized_rh_base_url != old_rh_base_url or normalized_model_name != old_model_name:
        data['rh_base_url'] = normalized_rh_base_url
        data['model_name'] = normalized_model_name
        with data_lock:
            latest = load_json('model_config.json') or {}
            latest['rh_base_url'] = normalized_rh_base_url
            latest['model_name'] = normalized_model_name
            save_json('model_config.json', latest)
    # 填充默认系统提示词（如果用户没有自定义）
    if not data.get('system_prompt_prompt'):
        data['system_prompt_prompt'] = """你是一个人像摄影 Prompt 整理助手。你的任务是将用户提供的结构化关键词改写为自然、简洁的中文 Prompt。

规则：
1. 只能使用用户提供的内容，不允许添加新的设定
2. 必须保留原始语义，不允许改变人物、气质、妆容、瑕疵的本意
3. 输出必须是自然中文，不能只是把词堆在一起
4. 输出要简洁，优先控制在1句，最长不超过2句
5. 不得输出解释、说明、注释、标题、编号
6. 瑕疵类内容应表达得自然真实，避免生硬、负面或医学化表述
7. 句子整体应偏写实，不要诗意化，不要广告化
8. 按以下顺序组织内容：前缀/画面形式 → 人物主体 → 国家地区 → 气质 → 妆容 → 表情 → 真实细节/瑕疵 → 后缀/整体导向

只输出最终的 Prompt，不要输出任何其他内容。"""
    if not data.get('system_prompt_bilingual'):
        data['system_prompt_bilingual'] = BILINGUAL_SYSTEM_PROMPT
    if not data.get('system_prompt_translate'):
        data['system_prompt_translate'] = """你是一个AI图像提示词翻译专家。将用户提供的中文 Prompt 翻译为专业的英文图像生成提示词。

要求：
- 使用专业摄影和AI绘图术语
- 保留所有语义细节
- 强调画面质量、构图、光影
- 只输出英文翻译结果，不要输出任何解释"""
    # 遮蔽API密钥，前端只显示遮蔽版
    masked = dict(data)
    for key_field in ['api_key', 'rh_api_key', 'oaihk_api_key']:
        if masked.get(key_field):
            masked[key_field] = _mask_api_key(masked[key_field])
    return jsonify(masked)


@app.route('/api/model-config', methods=['PUT'])
@_local_only
def update_model_config():
    body = request.get_json()
    # 只允许已知字段，防止注入任意键
    ALLOWED_FIELDS = {
        'provider', 'api_key', 'base_url', 'model_name', 'timeout_ms', 'retry_count',
        'system_prompt_prompt', 'system_prompt_translate', 'system_prompt_bilingual',
        'rh_api_key', 'rh_base_url', 'rh_model', 'rh_aspect_ratio', 'rh_resolution', 'rh_count', 'rh_seed_mode', 'rh_seed',
        'oaihk_api_key', 'oaihk_base_url', 'oaihk_model', 'oaihk_aspect_ratio', 'oaihk_gpt_quality',
        'api_platform', 'rh_download_path', 'upload_short_edge', 'upload_mode',
        'image_counter', 'image_prefix', 'defaultCropPreset', 'oaihk_image_timeout_sec',
    }
    body = {k: v for k, v in body.items() if k in ALLOWED_FIELDS}
    # 自动去除关键字段的空格
    for key in ['api_key', 'base_url', 'model_name']:
        if key in body and isinstance(body[key], str):
            body[key] = body[key].strip()
    if 'rh_base_url' in body:
        body['rh_base_url'] = _normalize_runninghub_base_url(body.get('rh_base_url'))
    if 'provider' in body or 'model_name' in body:
        current = load_json('model_config.json') or {}
        body['model_name'] = _normalize_prompt_model(
            body.get('provider', current.get('provider')),
            body.get('model_name', current.get('model_name')),
        )
    # 合并到现有配置，避免丢失未提交的字段（如system_prompt_*）
    with data_lock:
        existing = load_json('model_config.json')
        if existing is None:
            existing = {}
        # 遮蔽的密钥值（含****）不应覆盖真实密钥
        for key_field in ['api_key', 'rh_api_key', 'oaihk_api_key']:
            if key_field in body and '****' in str(body.get(key_field, '')):
                del body[key_field]  # 保留原有密钥
        existing.update(body)
        save_json('model_config.json', existing)
    logger.info(f"更新模型配置: provider={existing.get('provider')}")
    # 返回遮蔽后的配置，避免泄露 API 密钥
    masked = dict(existing)
    for key_field in ['api_key', 'rh_api_key', 'oaihk_api_key']:
        if key_field in masked and masked[key_field]:
            masked[key_field] = _mask_api_key(masked[key_field])
    return jsonify(masked)


@app.route('/api/test-connection', methods=['POST'])
def test_connection():
    config = request.get_json()
    provider = (config.get('provider') or 'deepseek').strip()
    api_key = (config.get('api_key') or '').strip()
    base_url = (config.get('base_url') or '').strip()
    model_name = (config.get('model_name') or '').strip()
    try:
        timeout_ms = int(config.get('timeout_ms', 30000))
        if timeout_ms <= 0:
            timeout_ms = 30000
    except (ValueError, TypeError):
        timeout_ms = 30000

    if not api_key:
        return jsonify({"success": False, "message": "API Key 不能为空"}), 400

    try:
        if provider == 'deepseek':
            url = (base_url.rstrip('/') if base_url else 'https://api.deepseek.com') + '/chat/completions'
            model = model_name or DEFAULT_DEEPSEEK_MODEL
        else:  # glm
            url = (base_url.rstrip('/') if base_url else 'https://open.bigmodel.cn/api/paas/v4') + '/chat/completions'
            model = model_name or 'glm-4-flash'

        headers = {
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json'
        }
        payload = {
            'model': model,
            'messages': [{'role': 'user', 'content': '你好'}],
            'max_tokens': 10
        }

        resp = requests.post(url, headers=headers, json=payload, timeout=timeout_ms / 1000)
        if resp.status_code == 200:
            return jsonify({"success": True, "message": f"连接成功 ({provider})"})
        else:
            return jsonify({"success": False, "message": f"连接失败: HTTP {resp.status_code}"})

    except requests.exceptions.Timeout:
        return jsonify({"success": False, "message": "连接超时"})
    except Exception as e:
        return jsonify({"success": False, "message": f"连接失败: {str(e)}"})


# ========== 最近选择 API ==========

@app.route('/api/last-selection', methods=['GET'])
def get_last_selection():
    data = load_json('last_selection.json')
    if data is None:
        return jsonify({"selected_prefixes": [], "selected_items": [], "selected_suffixes": [], "selected_props": []})
    return jsonify(data)


@app.route('/api/last-selection', methods=['PUT'])
def save_last_selection():
    body = request.get_json()
    with data_lock:
        save_json('last_selection.json', body)
    return jsonify({"success": True})


# ========== 队列数据 API ==========

def _validate_queue_payload(body):
    if not isinstance(body, dict):
        return False, "请求体必须是JSON对象"
    queues = body.get("queues")
    if queues is None or not isinstance(queues, list):
        return False, "queues 必须是数组"
    queue_count = body.get("queueCount", max(10, len(queues)))
    if not isinstance(queue_count, int) or queue_count < 10 or queue_count > 20:
        return False, "queueCount 必须在10到20之间"
    if len(queues) < queue_count or len(queues) > 20:
        return False, "queues 数量必须覆盖queueCount且不能超过20"
    active_queue = body.get("activeQueue", 0)
    if not isinstance(active_queue, int) or active_queue < 0 or active_queue >= queue_count:
        return False, "activeQueue 必须在当前队列范围内"
    queue_mode = body.get("queueMode", "same")
    if queue_mode not in ("same", "multi", "split"):
        return False, "queueMode 仅支持 same/multi/split"
    return True, ""


def _validate_split_queue_payload(body):
    if not isinstance(body, dict):
        return False, "请求体必须是JSON对象"
    queues = body.get("queues")
    if queues is None or not isinstance(queues, list):
        return False, "queues 必须是数组"
    active_queue = body.get("activeQueue", 0)
    if not isinstance(active_queue, int) or active_queue < 0:
        return False, "activeQueue 必须是非负整数"
    return True, ""

@app.route('/api/queue-data', methods=['GET'])
def get_queue_data():
    data = load_json('queue_data.json')
    if data is None:
        return jsonify({"queues": [], "queueCount": 10, "activeQueue": 0, "queueMode": "same", "slots": []})
    return jsonify(data)


@app.route('/api/queue-data', methods=['PUT'])
def save_queue_data():
    body = request.get_json()
    ok, err = _validate_queue_payload(body)
    if not ok:
        return jsonify({"success": False, "error": err}), 400
    with data_lock:
        save_json('queue_data.json', body)
    return jsonify({"success": True})


# ========== 拆图队列数据 API ==========

@app.route('/api/split-queue-data', methods=['GET'])
def get_split_queue_data():
    data = load_json('split_queue_data.json')
    if data is None:
        return jsonify({"queues": [], "activeQueue": 0})
    return jsonify(data)


def _split_result_key(item):
    if not isinstance(item, dict):
        return ''
    for key in ('localUrl', 'url', 'local_path', 'filename'):
        val = item.get(key)
        if val:
            return str(val)
    try:
        return json.dumps(item, ensure_ascii=False, sort_keys=True)
    except Exception:
        return str(item)


def _split_failure_key(item):
    if not isinstance(item, dict):
        return ''
    return f"{item.get('materialIndex', 0)}:{item.get('itemIndex', 0)}:{item.get('gridNum', '')}"


def _split_result_source_key(item):
    if not isinstance(item, dict):
        return ''
    return f"{item.get('_materialIndex', 0)}:{item.get('_splitItemIndex', 0)}:{item.get('_splitGridNum', '')}"


def _split_failure_richness(item):
    if not isinstance(item, dict):
        return 0
    score = 0
    for key in ('promptSnapshot', 'promptBodySnapshot', 'sourceUrlSnapshot', 'gridImageUrlSnapshot', 'apiPlatform', 'oaihkModelId', 'rhModelId'):
        if item.get(key):
            score += 1
    imgs = item.get('imageUrlsSnapshot') or item.get('imageUrls') or []
    if isinstance(imgs, list):
        score += min(len([x for x in imgs if x]), 4)
    return score


def _merge_split_queue_for_save(existing_q, incoming_q, allow_clear_results=False, allow_clear_failures=False):
    """Protect newer async split results from being overwritten by stale browser saves."""
    if not isinstance(existing_q, dict) or not isinstance(incoming_q, dict):
        return incoming_q
    merged = dict(incoming_q)

    existing_results = existing_q.get('results') if isinstance(existing_q.get('results'), list) else []
    incoming_results = incoming_q.get('results') if isinstance(incoming_q.get('results'), list) else []
    if existing_results:
        out = list(incoming_results)
        if out:
            seen = {_split_result_key(x) for x in out if _split_result_key(x)}
            for item in existing_results:
                key = _split_result_key(item)
                if key and key not in seen:
                    out.append(item)
                    seen.add(key)
            merged['results'] = out
        elif allow_clear_results:
            merged['results'] = []
        else:
            merged['results'] = existing_results

    existing_failed = existing_q.get('failedItems') if isinstance(existing_q.get('failedItems'), list) else []
    incoming_failed = incoming_q.get('failedItems') if isinstance(incoming_q.get('failedItems'), list) else []
    if existing_failed:
        if allow_clear_failures and not incoming_failed:
            merged['failedItems'] = []
        else:
            by_key = {}
            order = []
            for item in incoming_failed:
                key = _split_failure_key(item)
                if key and key not in by_key:
                    order.append(key)
                by_key[key] = item
            for item in existing_failed:
                key = _split_failure_key(item)
                if not key:
                    continue
                if key not in by_key:
                    order.append(key)
                    by_key[key] = item
                elif _split_failure_richness(item) > _split_failure_richness(by_key[key]):
                    by_key[key] = item
            if by_key:
                merged['failedItems'] = [by_key[k] for k in order if k in by_key]
            else:
                merged['failedItems'] = existing_failed

    result_source_keys = {
        _split_result_source_key(item)
        for item in (merged.get('results') if isinstance(merged.get('results'), list) else [])
        if _split_result_source_key(item)
    }
    if result_source_keys and isinstance(merged.get('failedItems'), list):
        merged['failedItems'] = [
            item for item in merged['failedItems']
            if _split_failure_key(item) not in result_source_keys
        ]

    return merged


@app.route('/api/split-queue-data', methods=['PUT'])
def save_split_queue_data():
    body = request.get_json()
    ok, err = _validate_split_queue_payload(body)
    if not ok:
        return jsonify({"success": False, "error": err}), 400
    with data_lock:
        existing = load_json('split_queue_data.json') or {}
        # Merge: update queues by index instead of wholesale overwrite
        incoming_queues = body.get('queues', [])
        existing_queues = existing.get('queues', [])
        clear_results_queues = set(body.get('clearResultsQueues') or [])
        clear_failures_queues = set(body.get('clearFailuresQueues') or [])
        for i, q in enumerate(incoming_queues):
            if i < len(existing_queues):
                existing_queues[i] = _merge_split_queue_for_save(
                    existing_queues[i],
                    q,
                    allow_clear_results=i in clear_results_queues,
                    allow_clear_failures=i in clear_failures_queues
                )
            else:
                existing_queues.append(q)
        # Truncate if incoming is shorter than existing
        existing_queues = existing_queues[:len(incoming_queues)]
        existing['queues'] = existing_queues
        if 'activeQueue' in body:
            existing['activeQueue'] = body['activeQueue']
        if 'queueMode' in body:
            existing['queueMode'] = body['queueMode']
        save_json('split_queue_data.json', existing)
    return jsonify({"success": True})


@app.route('/api/undo-state', methods=['PUT'])
def restore_undo_state():
    """恢复前端全局撤销快照中允许写回的 JSON 数据。"""
    body = request.get_json(silent=True) or {}
    files = body.get('files')
    if not isinstance(files, dict):
        return jsonify({"success": False, "error": "files 必须是对象"}), 400

    allowed_files = {
        'categories.json',
        'prefixes.json',
        'suffixes.json',
        'props.json',
        'presets.json',
        'preset_tags.json',
        'category_order.json',
        'prop_order.json',
        'last_selection.json',
        'queue_data.json',
        'split_queue_data.json',
        'image_library.json',
        'image_presets.json',
        'prompt_templates.json',
        'prompt_presets.json',
        'prefix_templates.json',
    }

    to_save = {}
    for filename, payload in files.items():
        if filename not in allowed_files:
            return jsonify({"success": False, "error": f"不允许恢复文件: {filename}"}), 400
        if not isinstance(payload, (dict, list)):
            return jsonify({"success": False, "error": f"{filename} 必须是对象或数组"}), 400
        to_save[filename] = payload

    with data_lock:
        for filename, payload in to_save.items():
            save_json(filename, payload)

    logger.info(f"撤销恢复状态: {len(to_save)} 个数据文件")
    return jsonify({"success": True, "restored": sorted(to_save.keys())})


# ========== 道具 API ==========

@app.route('/api/props', methods=['GET'])
def get_props():
    data = load_json('props.json')
    if data is None:
        return jsonify({"props": []})
    return jsonify(data)


@app.route('/api/props', methods=['POST'])
def create_prop():
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "道具分类名称不能为空"}), 400

    with data_lock:
        data = load_json('props.json')
        if data is None:
            data = {"props": []}

        prop = {
            "id": gen_id('prop'),
            "name": name,
            "items": []
        }
        data['props'].append(prop)
        save_json('props.json', data)

    logger.info(f"新增道具分类: {name}")
    return jsonify(prop), 201


@app.route('/api/props/<prop_id>', methods=['PUT'])
def update_prop(prop_id):
    body = request.get_json()
    name = body.get('name', '').strip()

    with data_lock:
        data = load_json('props.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for prop in data['props']:
            if prop['id'] == prop_id:
                if name:
                    prop['name'] = name
                save_json('props.json', data)
                logger.info(f"更新道具分类: {prop_id} -> {name}")
                return jsonify(prop)

    return jsonify({"error": "道具分类不存在"}), 404


@app.route('/api/props/<prop_id>', methods=['DELETE'])
def delete_prop(prop_id):
    with data_lock:
        data = load_json('props.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        data['props'] = [p for p in data['props'] if p['id'] != prop_id]
        save_json('props.json', data)
        _remove_from_order('prop', prop_id)

    logger.info(f"删除道具分类: {prop_id}")
    return jsonify({"success": True})


# ========== 道具排序 API ==========

@app.route('/api/prop-order', methods=['GET'])
def get_prop_order():
    data = load_json('prop_order.json')
    if data is None:
        return jsonify({"order": []})
    return jsonify(data)


@app.route('/api/prop-order', methods=['PUT'])
def update_prop_order():
    body = request.get_json()
    order = body.get('order', [])
    with data_lock:
        save_json('prop_order.json', {"order": order})
    logger.info(f"更新道具排序: {len(order)} 项")
    return jsonify({"success": True})


# 道具子项 API

@app.route('/api/props/<prop_id>/items', methods=['POST'])
def create_prop_item(prop_id):
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "道具名称不能为空"}), 400

    with data_lock:
        data = load_json('props.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for prop in data['props']:
            if prop['id'] == prop_id:
                item = {
                    "id": gen_id('propitem'),
                    "name": name,
                    "image": ""
                }
                prop['items'].append(item)
                save_json('props.json', data)
                logger.info(f"新增道具: {name} (分类: {prop['name']})")
                return jsonify(item), 201

    return jsonify({"error": "道具分类不存在"}), 404


@app.route('/api/props/<prop_id>/items/<item_id>', methods=['PUT'])
def update_prop_item(prop_id, item_id):
    body = request.get_json()
    name = body.get('name', '').strip()
    image = body.get('image')

    with data_lock:
        data = load_json('props.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for prop in data['props']:
            if prop['id'] == prop_id:
                for item in prop['items']:
                    if item['id'] == item_id:
                        if name:
                            item['name'] = name
                        if image is not None:
                            item['image'] = image
                        save_json('props.json', data)
                        logger.info(f"更新道具: {item_id} -> {name}")
                        return jsonify(item)

    return jsonify({"error": "道具不存在"}), 404


@app.route('/api/props/<prop_id>/items/<item_id>', methods=['DELETE'])
def delete_prop_item(prop_id, item_id):
    with data_lock:
        data = load_json('props.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for prop in data['props']:
            if prop['id'] == prop_id:
                prop['items'] = [i for i in prop['items'] if i['id'] != item_id]
                save_json('props.json', data)
                logger.info(f"删除道具: {item_id}")
                return jsonify({"success": True})

    return jsonify({"error": "道具分类不存在"}), 404


# ========== Prompt 生成 ==========

def build_local_prompt(selected_prefixes, selected_items, selected_suffixes, selected_props, categories_data, prefixes_data, suffixes_data, props_data, category_order):
    """本地兜底生成：按排序顺序拼接"""
    parts = []

    # 构建查找表
    prefix_map = {p['id']: p['name'] for p in prefixes_data.get('prefixes', [])}
    suffix_map = {s['id']: s['name'] for s in suffixes_data.get('suffixes', [])}

    # 构建 category id -> items 的映射
    cat_items_map = {}
    for cat in categories_data.get('categories', []):
        cat_items_map[cat['id']] = cat

    # 构建 prop id -> items 的映射
    prop_items_map = {}
    for prop in props_data.get('props', []):
        prop_items_map[prop['id']] = prop

    # 如果没有排序数据，使用默认顺序
    if not category_order:
        category_order = []
        for cat in categories_data.get('categories', []):
            category_order.append({'type': 'category', 'id': cat['id']})
        category_order.append({'type': 'prefix', 'id': 'prefix'})
        category_order.append({'type': 'suffix', 'id': 'suffix'})
        for prop in props_data.get('props', []):
            category_order.append({'type': 'prop', 'id': prop['id']})

    # 按排序顺序拼接
    for order_item in category_order:
        otype = order_item.get('type')
        oid = order_item.get('id')

        if otype == 'prefix':
            for pid in selected_prefixes:
                if pid in prefix_map:
                    parts.append(prefix_map[pid])

        elif otype == 'suffix':
            for sid in selected_suffixes:
                if sid in suffix_map:
                    parts.append(suffix_map[sid])

        elif otype == 'category':
            cat = cat_items_map.get(oid)
            if cat:
                cat_item_names = []
                for it in cat['items']:
                    if it['id'] in selected_items:
                        cat_item_names.append(it['name'])
                if cat_item_names:
                    parts.append('，'.join(cat_item_names))

        elif otype == 'prop':
            prop = prop_items_map.get(oid)
            if prop:
                prop_item_names = []
                for it in prop['items']:
                    if it['id'] in selected_props:
                        prop_item_names.append(it['name'])
                if prop_item_names:
                    parts.append('，'.join(prop_item_names))

    return '，'.join(parts)


def call_llm(prompt_text, config):
    """调用大模型进行自然化改写"""
    provider = (config.get('provider') or 'deepseek').strip()
    api_key = (config.get('api_key') or '').strip()
    base_url = (config.get('base_url') or '').strip()
    model_name = (config.get('model_name') or '').strip()
    try:
        timeout_ms = int(config.get('timeout_ms', 30000))
        if timeout_ms <= 0:
            timeout_ms = 30000
    except (ValueError, TypeError):
        timeout_ms = 30000
    retry_count = config.get('retry_count', 2)

    if not api_key:
        return None, "API Key 未配置"

    system_prompt = """你是一个人像摄影 Prompt 整理助手。你的任务是将用户提供的结构化关键词改写为自然、简洁的中文 Prompt。

规则：
1. 只能使用用户提供的内容，不允许添加新的设定
2. 必须保留原始语义，不允许改变人物、气质、妆容、瑕疵的本意
3. 输出必须是自然中文，不能只是把词堆在一起
4. 输出要简洁，优先控制在1句，最长不超过2句
5. 不得输出解释、说明、注释、标题、编号
6. 瑕疵类内容应表达得自然真实，避免生硬、负面或医学化表述
7. 句子整体应偏写实，不要诗意化，不要广告化
8. 按以下顺序组织内容：前缀/画面形式 → 人物主体 → 国家地区 → 气质 → 妆容 → 表情 → 真实细节/瑕疵 → 后缀/整体导向

只输出最终的 Prompt，不要输出任何其他内容。"""

    # 使用自定义系统提示词（如果有）
    custom_prompt = config.get('system_prompt_prompt', '').strip()
    if custom_prompt:
        system_prompt = custom_prompt

    if provider == 'deepseek':
        url = (base_url.rstrip('/') if base_url else 'https://api.deepseek.com') + '/chat/completions'
        model = model_name or DEFAULT_DEEPSEEK_MODEL
    else:  # glm
        url = (base_url.rstrip('/') if base_url else 'https://open.bigmodel.cn/api/paas/v4') + '/chat/completions'
        model = model_name or 'glm-4-flash'

    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json'
    }
    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': f'请将以下关键词整理为自然中文 Prompt：\n{prompt_text}'}
        ],
        'temperature': 0.3,
        'max_tokens': 200
    }

    last_error = None
    for i in range(max(retry_count, 1)):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=timeout_ms / 1000)
            if resp.status_code == 200:
                result = resp.json()
                choices = result.get('choices', [])
                if not choices or not choices[0].get('message', {}).get('content'):
                    last_error = f"大模型返回空结果: {str(result)[:200]}"
                    logger.warning(f"大模型返回异常: {last_error}")
                    continue
                content = choices[0]['message']['content'].strip()
                logger.info(f"大模型生成成功 (provider={provider}, 第{i+1}次)")
                return content, None
            else:
                last_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
                logger.warning(f"大模型调用失败: {last_error}")
        except requests.exceptions.Timeout:
            last_error = "请求超时"
            logger.warning(f"大模型调用超时 (第{i+1}次)")
        except Exception as e:
            last_error = str(e)
            logger.warning(f"大模型调用异常: {last_error}")
        # 指数退避：重试前等待
        if i < retry_count - 1:
            wait = min(2 ** i, 10)
            logger.info(f"等待 {wait}s 后重试...")
            time.sleep(wait)

    return None, last_error


@app.route('/api/generate', methods=['POST'])
def generate_prompt():
    body = request.get_json()
    selected_prefixes = body.get('selected_prefixes', [])
    selected_items = body.get('selected_items', [])
    selected_suffixes = body.get('selected_suffixes', [])
    selected_props = body.get('selected_props', [])

    # 在锁内读取所有数据文件，确保一致性
    with data_lock:
        categories_data = load_json('categories.json') or {"categories": []}
        prefixes_data = load_json('prefixes.json') or {"prefixes": []}
        suffixes_data = load_json('suffixes.json') or {"suffixes": []}
        props_data = load_json('props.json') or {"props": []}
        model_config = load_json('model_config.json') or {}
        category_order = load_json('category_order.json') or {"order": []}

    # 1. 先生成本地兜底版本
    local_prompt = build_local_prompt(
        selected_prefixes, selected_items, selected_suffixes, selected_props,
        categories_data, prefixes_data, suffixes_data, props_data,
        category_order.get('order', [])
    )

    if not local_prompt:
        return jsonify({"error": "请至少选择一项内容"}), 400

    # 2. 尝试调用大模型
    llm_result, llm_error = call_llm(local_prompt, model_config)

    if llm_result:
        logger.info("Prompt 生成成功（大模型自然化）")
        return jsonify({
            "prompt": llm_result,
            "local_prompt": local_prompt,
            "source": "llm"
        })
    else:
        logger.warning(f"大模型改写失败，使用本地兜底: {llm_error}")
        return jsonify({
            "prompt": local_prompt,
            "local_prompt": local_prompt,
            "source": "local",
            "fallback_reason": llm_error or "大模型未配置"
        })


@app.route('/api/generate-from-text', methods=['POST'])
def generate_from_text():
    """直接用用户编辑的 prompt 文本调用大模型改写"""
    body = request.get_json()
    prompt_text = (body.get('prompt_text') or '').strip()

    if not prompt_text:
        return jsonify({"error": "prompt_text 不能为空"}), 400

    model_config = load_json('model_config.json') or {}

    llm_result, llm_error = call_llm(prompt_text, model_config)

    if llm_result:
        logger.info("Prompt 文本生成成功（大模型自然化）")
        return jsonify({
            "prompt": llm_result,
            "local_prompt": prompt_text,
            "source": "llm"
        })
    else:
        logger.warning(f"大模型改写失败，返回原始文本: {llm_error}")
        return jsonify({
            "prompt": prompt_text,
            "local_prompt": prompt_text,
            "source": "local",
            "fallback_reason": llm_error or "大模型未配置"
        })


# ========== 数据导入导出 ==========

DATA_FILES = [
    'categories.json', 'prefixes.json', 'suffixes.json',
    'props.json', 'presets.json', 'preset_tags.json',
    'category_order.json', 'prop_order.json', 'last_selection.json',
    'image_library.json', 'image_presets.json', 'queue_data.json',
    'split_queue_data.json',
    'model_config.json', 'usage_log.json', 'prefix_templates.json',
    'prompt_templates.json', 'prompt_presets.json',
    'ecommerce_prompt_templates.json'
]


@app.route('/api/export', methods=['POST'])
def export_data():
    """选择性导出数据（JSON + 引用的图片）为 zip"""
    body = request.get_json(silent=True) or {}
    selected = body.get('selected', {})  # {image_library: true, image_presets: true, ...}

    # 数据文件到导出类别的映射
    FILE_CATEGORY_MAP = {
        'image_library': ['image_library.json'],
        'image_presets': ['image_presets.json', 'queue_data.json'],
        'prefixes_suffixes': ['prefixes.json', 'suffixes.json', 'prefix_templates.json', 'prompt_templates.json', 'prompt_presets.json'],
        'categories': ['categories.json', 'category_order.json', 'props.json', 'prop_order.json', 'last_selection.json', 'preset_tags.json'],
        'presets': ['presets.json'],
        'model_config': ['model_config.json'],
    }

    # 确定要导出的文件
    export_files = set()
    for cat, files in FILE_CATEGORY_MAP.items():
        if selected.get(cat, True):
            export_files.update(files)

    # 先在锁内快速读取所有需要的数据，再在锁外生成ZIP
    with data_lock:
        export_data_map = {}
        for filename in export_files:
            data_content = load_json(filename)
            if data_content is not None:
                if filename == 'model_config.json':
                    safe_copy = dict(data_content)
                    for key_field in ['api_key', 'rh_api_key', 'oaihk_api_key']:
                        safe_copy.pop(key_field, None)
                    export_data_map[filename] = safe_copy
                else:
                    export_data_map[filename] = data_content

    # 在锁外生成ZIP（I/O密集操作不阻塞其他写操作）
    referenced_images = set()
    for filename, data_content in export_data_map.items():
        _collect_image_refs(data_content, referenced_images)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for filename, data_content in export_data_map.items():
            zf.writestr(f'data/{filename}', json.dumps(data_content, ensure_ascii=False, indent=2))
        for img_name in referenced_images:
            img_path = os.path.join(IMAGES_DIR, img_name)
            if os.path.exists(img_path):
                zf.write(img_path, f'images/{img_name}')
        zf.writestr('data/export_manifest.json', json.dumps({
            'selected': {k: v for k, v in selected.items() if v},
            'exported_files': list(export_files),
            'timestamp': time.strftime('%Y-%m-%d %H:%M:%S')
        }, ensure_ascii=False, indent=2))

    buf.seek(0)
    timestamp = time.strftime('%Y%m%d_%H%M%S')
    logger.info(f"选择性导出数据: {len(export_files)}个文件, {len(referenced_images)}张图片")
    return send_file(buf, mimetype='application/zip',
                     as_attachment=True,
                     download_name=f'prompt_generator_export_{timestamp}.zip')


def _collect_image_refs(obj, refs):
    """递归收集 JSON 中所有 /static/images/xxx 的图片文件名"""
    if isinstance(obj, str):
        if obj.startswith('/static/images/'):
            img_name = obj.replace('/static/images/', '')
            refs.add(img_name)
    elif isinstance(obj, dict):
        for v in obj.values():
            _collect_image_refs(v, refs)
    elif isinstance(obj, list):
        for item in obj:
            _collect_image_refs(item, refs)


def _collect_orphan_internal_images():
    """收集 static/images 中未被业务 JSON 引用的顶层图片文件。"""
    referenced_images = set()
    for filename in DATA_FILES:
        filepath = os.path.join(DATA_DIR, filename)
        if not os.path.exists(filepath):
            continue
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
            _collect_image_refs(data, referenced_images)
        except Exception:
            pass

    img_exts = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'}
    orphaned = []
    if os.path.exists(IMAGES_DIR):
        for img_file in os.listdir(IMAGES_DIR):
            if img_file.startswith('.'):
                continue
            img_path = os.path.join(IMAGES_DIR, img_file)
            if not os.path.isfile(img_path):
                continue
            if os.path.splitext(img_file)[1].lower() not in img_exts:
                continue
            if img_file in referenced_images:
                continue
            try:
                size = os.path.getsize(img_path)
            except OSError:
                size = 0
            orphaned.append({"name": img_file, "path": img_path, "size": size})
    orphaned.sort(key=lambda x: x.get("name", ""))
    return orphaned


@app.route('/api/cleanup-images-preview', methods=['GET'])
def cleanup_images_preview():
    """预览未被任何 JSON 数据引用的内部孤立图片，不移动文件。"""
    with data_lock:
        orphaned = _collect_orphan_internal_images()
    total_bytes = sum(item.get("size", 0) for item in orphaned)
    return jsonify({
        "success": True,
        "count": len(orphaned),
        "size_kb": round(total_bytes / 1024, 1),
        "sample": [item["name"] for item in orphaned[:12]]
    })


@app.route('/api/cleanup-images', methods=['POST'])
def cleanup_images():
    """清理未被任何 JSON 数据引用的孤立图片"""
    with data_lock:
        orphaned = _collect_orphan_internal_images()
        if not orphaned:
            logger.info("清理未引用图片: 未发现孤立图片")
            return jsonify({
                "success": True,
                "deleted": 0,
                "trashed": 0,
                "freed_kb": 0
            })

        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        staging_dir = os.path.join(BACKUP_DIR, f'orphan_images_{timestamp}')
        os.makedirs(staging_dir, exist_ok=False)

        moved = []
        freed_bytes = 0
        try:
            for item in orphaned:
                src = item["path"]
                dst = os.path.join(staging_dir, item["name"])
                shutil.move(src, dst)
                moved.append((src, dst))
                freed_bytes += item.get("size", 0)
            _move_path_to_trash(staging_dir)
            deleted_count = len(moved)
        except Exception as e:
            logger.warning(f"清理图片失败，尝试回滚: {e}")
            for src, dst in reversed(moved):
                try:
                    if os.path.exists(dst) and not os.path.exists(src):
                        shutil.move(dst, src)
                except Exception as rollback_error:
                    logger.warning(f"回滚孤立图片失败: {dst} -> {src}, {rollback_error}")
            try:
                if os.path.isdir(staging_dir) and not os.listdir(staging_dir):
                    os.rmdir(staging_dir)
            except Exception:
                pass
            return jsonify({"error": f"清理失败: {e}"}), 500

    logger.info(f"清理未引用图片: 打包移到回收站{deleted_count}张, 释放{freed_bytes//1024}KB")
    return jsonify({
        "success": True,
        "deleted": deleted_count,
        "trashed": deleted_count,
        "freed_kb": freed_bytes // 1024,
        "trashed_folder": os.path.basename(staging_dir)
    })


@app.route('/api/dwpose-cache-stats', methods=['GET'])
def dwpose_cache_stats():
    total = 0
    size_kb = 0
    if os.path.isdir(DWPOSE_CACHE_DIR):
        for name in os.listdir(DWPOSE_CACHE_DIR):
            fp = os.path.join(DWPOSE_CACHE_DIR, name)
            if not os.path.isfile(fp):
                continue
            total += 1
            try:
                size_kb += os.path.getsize(fp) / 1024
            except OSError:
                pass
    return jsonify({"count": total, "size_kb": round(size_kb, 1)})


@app.route('/api/cleanup-dwpose-cache', methods=['POST'])
def cleanup_dwpose_cache():
    body = request.get_json(silent=True) or {}
    days = body.get('days')
    cutoff = None
    if days not in (None, '', 'all'):
        try:
            cutoff = time.time() - max(0, int(days)) * 24 * 60 * 60
        except (TypeError, ValueError):
            return jsonify({"error": "days 必须是整数或 all"}), 400

    moved = 0
    freed_kb = 0
    errors = []
    if os.path.isdir(DWPOSE_CACHE_DIR):
        for name in os.listdir(DWPOSE_CACHE_DIR):
            fp = os.path.join(DWPOSE_CACHE_DIR, name)
            if not os.path.isfile(fp):
                continue
            try:
                if cutoff is not None and os.path.getmtime(fp) > cutoff:
                    continue
                freed_kb += os.path.getsize(fp) / 1024
                _move_path_to_trash(fp)
                moved += 1
            except Exception as e:
                errors.append(f"{name}: {e}")
    logger.info(f"清理DWPose缓存: 移到回收站{moved}个, 释放{round(freed_kb, 1)}KB")
    return jsonify({"success": True, "deleted": moved, "trashed": moved, "freed_kb": round(freed_kb, 1), "errors": errors[:5]})


@app.route('/api/cleanup-queue-results', methods=['POST'])
def cleanup_queue_results():
    body = request.get_json(silent=True) or {}
    kind = body.get('kind', 'image')
    scope = body.get('scope', 'current')
    index = int(body.get('index', 0) or 0)
    if kind not in ('image', 'split'):
        return jsonify({"error": "kind 仅支持 image/split"}), 400
    if scope not in ('current', 'all'):
        return jsonify({"error": "scope 仅支持 current/all"}), 400

    filename = 'split_queue_data.json' if kind == 'split' else 'queue_data.json'
    data = load_json(filename) or {}
    queues = data.get('queues') or []
    targets = range(len(queues)) if scope == 'all' else [index]
    cleared = 0
    with data_lock:
        for qi in targets:
            if qi < 0 or qi >= len(queues) or not isinstance(queues[qi], dict):
                continue
            q = queues[qi]
            cleared += len(q.get('results') or [])
            q['results'] = []
            q['progressDone'] = 0
            q['progressTotal'] = 0
            q['failedItems'] = []
        data['queues'] = queues
        save_json(filename, data)
    return jsonify({"success": True, "cleared": cleared})


@app.route('/api/import', methods=['POST'])
@_local_only
def import_data():
    """选择性导入 zip 数据包，同名冲突加"新"后缀"""
    if 'file' not in request.files:
        return jsonify({"error": "没有上传文件"}), 400

    file = request.files['file']
    if not file.filename.endswith('.zip'):
        return jsonify({"error": "仅支持 .zip 格式"}), 400

    # 读取选择参数（从form field）
    selected_json = request.form.get('selected', '{}')
    try:
        selected = json.loads(selected_json)
    except Exception:
        selected = {}

    # 数据文件到类别的映射
    FILE_CATEGORY_MAP = {
        'image_library': ['image_library.json'],
        'image_presets': ['image_presets.json', 'queue_data.json'],
        'prefixes_suffixes': ['prefixes.json', 'suffixes.json', 'prefix_templates.json', 'prompt_templates.json', 'prompt_presets.json'],
        'categories': ['categories.json', 'category_order.json', 'props.json', 'prop_order.json', 'last_selection.json', 'preset_tags.json'],
        'presets': ['presets.json'],
        'model_config': ['model_config.json'],
    }

    # 反向映射：文件名 → 类别
    FILE_TO_CATEGORY = {}
    for cat, files in FILE_CATEGORY_MAP.items():
        for f in files:
            FILE_TO_CATEGORY[f] = cat

    # 确定要导入的文件集合
    import_files = set()
    for cat, files in FILE_CATEGORY_MAP.items():
        if selected.get(cat, True):
            import_files.update(files)

    # 需要合并（而非覆盖）的数据文件：有name字段的列表型数据
    MERGE_FILES = {'image_presets.json', 'presets.json', 'image_library.json', 'prefixes.json', 'suffixes.json'}

    try:
        imported = {"data_files": 0, "images": 0, "merged": 0, "renamed": 0}

        file_bytes = file.read()

        with data_lock:
            with zipfile.ZipFile(io.BytesIO(file_bytes), 'r') as zf:
                # ZIP炸弹防护：检查总大小和条目数
                total_size = 0
                for info in zf.infolist():
                    total_size += info.file_size
                    if total_size > 200 * 1024 * 1024:  # 200MB限制
                        return jsonify({"error": "ZIP解压后超过200MB限制"}), 413
                names = zf.namelist()

                # 导入 JSON 数据文件
                for name in names:
                    if name.startswith('data/') and name.endswith('.json'):
                        filename = os.path.basename(name)
                        if filename == 'export_manifest.json':
                            continue
                        if filename not in import_files:
                            continue
                        if filename not in DATA_FILES:
                            continue

                        content = zf.read(name).decode('utf-8')
                        incoming_data = json.loads(content)

                        if filename in MERGE_FILES:
                            filepath = os.path.join(DATA_DIR, filename)
                            if os.path.exists(filepath):
                                local_data = load_json(filename) or {}
                                merged, renamed = _merge_named_data(filename, local_data, incoming_data)
                                save_json(filename, merged)
                                imported['merged'] += 1
                                imported['renamed'] += renamed
                            else:
                                save_json(filename, incoming_data)
                        else:
                            save_json(filename, incoming_data)

                        imported['data_files'] += 1

                # 导入图片
                for name in names:
                    if name.startswith('images/'):
                        img_name = os.path.basename(name)
                        img_path = os.path.join(IMAGES_DIR, img_name)
                        img_data = zf.read(name)
                        with open(img_path, 'wb') as f:
                            f.write(img_data)
                        imported['images'] += 1

        supplement = {"added": 0, "skipped_same_hash": 0}
        # 导入图生图预设时，自动把预设引用图补到素材库（同分类+同hash去重）
        if 'image_presets.json' in import_files and selected.get('image_presets', True) and selected.get('auto_supplement', True):
            supplement = _supplement_library_from_image_presets()

        logger.info(
            f"选择性导入: {imported['data_files']}个文件, {imported['images']}张图片, "
            f"{imported['renamed']}个重命名, 补全素材{supplement['added']}个, 同分类同图跳过{supplement['skipped_same_hash']}个"
        )
        return jsonify({"success": True, "imported": imported, "supplement": supplement})
    except json.JSONDecodeError:
        return jsonify({"error": "数据文件格式错误，不是合法的 JSON"}), 400
    except zipfile.BadZipFile:
        return jsonify({"error": "zip 文件损坏"}), 400
    except Exception as e:
        logger.error(f"导入失败: {e}")
        return jsonify({"error": "服务内部错误"}), 500


def _merge_named_data(filename, local_data, incoming_data):
    """合并两个有name字段的列表型数据，同名项加"新"后缀
    使用深拷贝避免嵌套数据共享，递归处理素材库的 subcategories → items 层级
    返回 (merged_data, rename_count)"""
    import copy
    rename_count = 0

    # 确定列表的key和name字段
    if filename == 'image_library.json':
        list_key = 'categories'
        name_field = 'name'
    elif filename in ('presets.json', 'image_presets.json'):
        list_key = 'presets'
        name_field = 'name'
    elif filename in ('prefixes.json', 'suffixes.json'):
        list_key = 'prefixes' if filename == 'prefixes.json' else 'suffixes'
        name_field = 'name'
    else:
        return incoming_data, 0

    local_list = local_data.get(list_key, [])
    incoming_list = incoming_data.get(list_key, [])

    # 收集本地所有name（包括子层级）
    local_names = set()
    for item in local_list:
        if name_field in item:
            local_names.add(item[name_field])
        # 素材库：收集子分类名和子分类内item名
        if filename == 'image_library.json':
            for sub in item.get('subcategories', []):
                if 'name' in sub:
                    local_names.add(sub['name'])
                for it in sub.get('items', []):
                    if 'name' in it:
                        local_names.add(it['name'])

    def _rename_if_conflict(name, local_names_set):
        """如果name冲突，加"新"后缀直到不冲突"""
        if name not in local_names_set:
            return name, False
        new_name = name + '新'
        counter = 2
        while new_name in local_names_set:
            new_name = f"{name}新{counter}"
            counter += 1
        local_names_set.add(new_name)
        return new_name, True

    # 合并incoming的项（深拷贝）
    for item in incoming_list:
        item_copy = copy.deepcopy(item)

        # 重命名同名顶级项
        if name_field in item_copy:
            new_name, renamed = _rename_if_conflict(item_copy[name_field], local_names)
            if renamed:
                item_copy[name_field] = new_name
                item_copy['id'] = gen_id('imp')
                rename_count += 1

        # 素材库：处理子分类和items
        if filename == 'image_library.json':
            for sub in item_copy.get('subcategories', []):
                if 'name' in sub:
                    new_name, renamed = _rename_if_conflict(sub['name'], local_names)
                    if renamed:
                        sub['name'] = new_name
                        sub['id'] = gen_id('imp')
                        rename_count += 1
                for it in sub.get('items', []):
                    if 'name' in it:
                        new_name, renamed = _rename_if_conflict(it['name'], local_names)
                        if renamed:
                            it['name'] = new_name
                            it['id'] = gen_id('imp')
                            rename_count += 1

        local_list.append(item_copy)

    local_data[list_key] = local_list
    return local_data, rename_count


# ========== 文生图系统 API ==========

# ---------- 双语 Prompt 生成 ----------

BILINGUAL_SYSTEM_PROMPT = """你是一个AI图像提示词专家。

任务：
根据中文描述 + 图片语义标签
输出：

1）中文优化版
2）英文专业提示词

要求：

英文必须：
- 使用 "Use the provided reference images"
- 标明：
  Image 1 for ...
  Image 2 for ...
- 强调一致性、构图、光影

输出格式：
【中文】
（中文优化版 Prompt）

【英文】
（英文专业提示词）

只输出上述内容，不要输出任何解释或说明。"""


def _parse_bilingual_result(content):
    """解析大模型返回的双语结果"""
    prompt_cn = ''
    prompt_en = ''

    if '【中文】' in content and '【英文】' in content:
        parts = content.split('【英文】')
        cn_part = parts[0].replace('【中文】', '').strip()
        en_part = parts[1].strip() if len(parts) > 1 else ''
        prompt_cn = cn_part
        prompt_en = en_part
    elif '【中文】' in content:
        prompt_cn = content.replace('【中文】', '').strip()
    elif '【英文】' in content:
        prompt_en = content.replace('【英文】', '').strip()
    else:
        # 无法解析格式，整段作为中文
        prompt_cn = content.strip()

    return prompt_cn, prompt_en


@app.route('/api/generate-bilingual', methods=['POST'])
def generate_bilingual():
    """文生图：生成双语 Prompt"""
    body = request.get_json()
    prompt_cn = (body.get('prompt_cn') or '').strip()
    images = body.get('images', [])

    if not prompt_cn and not images:
        return jsonify({"error": "请输入中文描述或添加图片语义标签"}), 400

    # 构建用户消息
    user_msg = ''
    if prompt_cn:
        user_msg += f'中文描述：{prompt_cn}\n'
    if images:
        img_labels = [f'Image {i+1} for {img.get("label", "未标注")}' for i, img in enumerate(images)]
        user_msg += f'图片语义标签：{", ".join(img_labels)}\n'

    model_config = load_json('model_config.json') or {}

    provider = (model_config.get('provider') or 'deepseek').strip()
    api_key = (model_config.get('api_key') or '').strip()
    base_url = (model_config.get('base_url') or '').strip()
    model_name = (model_config.get('model_name') or '').strip()
    try:
        timeout_ms = int(model_config.get('timeout_ms', 30000))
        if timeout_ms <= 0:
            timeout_ms = 30000
    except (ValueError, TypeError):
        timeout_ms = 30000
    retry_count = model_config.get('retry_count', 2)

    if not api_key:
        return jsonify({"error": "API Key 未配置，请先在模型配置中设置"}), 400

    # 使用自定义系统提示词（如果有），否则用默认
    custom_bilingual_prompt = model_config.get('system_prompt_bilingual', '').strip()
    system_prompt_to_use = custom_bilingual_prompt if custom_bilingual_prompt else BILINGUAL_SYSTEM_PROMPT

    if provider == 'deepseek':
        url = (base_url.rstrip('/') if base_url else 'https://api.deepseek.com') + '/chat/completions'
        model = model_name or DEFAULT_DEEPSEEK_MODEL
    else:
        url = (base_url.rstrip('/') if base_url else 'https://open.bigmodel.cn/api/paas/v4') + '/chat/completions'
        model = model_name or 'glm-4-flash'

    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json'
    }
    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system_prompt_to_use},
            {'role': 'user', 'content': user_msg}
        ],
        'temperature': 0.3,
        'max_tokens': 500
    }

    last_error = None
    for i in range(max(retry_count, 1)):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=timeout_ms / 1000)
            if resp.status_code == 200:
                result = resp.json()
                choices = result.get('choices', [])
                if not choices or not choices[0].get('message', {}).get('content'):
                    last_error = f"大模型返回空结果: {str(result)[:200]}"
                    logger.warning(f"双语生成返回异常: {last_error}")
                    continue
                content = choices[0]['message']['content'].strip()
                prompt_cn_result, prompt_en_result = _parse_bilingual_result(content)
                logger.info(f"双语 Prompt 生成成功 (provider={provider})")
                return jsonify({
                    "prompt_cn": prompt_cn_result or prompt_cn,
                    "prompt_en": prompt_en_result
                })
            else:
                last_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
                logger.warning(f"双语生成失败: {last_error}")
        except requests.exceptions.Timeout:
            last_error = "请求超时"
            logger.warning(f"双语生成超时 (第{i+1}次)")
        except Exception as e:
            last_error = str(e)
            logger.warning(f"双语生成异常: {last_error}")
        # 指数退避：重试前等待
        if i < retry_count - 1:
            wait = min(2 ** i, 10)
            logger.info(f"等待 {wait}s 后重试...")
            time.sleep(wait)

    return jsonify({"error": f"生成失败: {last_error}"}), 500


@app.route('/api/translate-to-en', methods=['POST'])
def translate_to_en():
    """文生图：将中文 Prompt 翻译为英文"""
    body = request.get_json()
    prompt_cn = (body.get('prompt_cn') or '').strip()

    if not prompt_cn:
        return jsonify({"error": "中文 Prompt 不能为空"}), 400

    model_config = load_json('model_config.json') or {}

    system_prompt = """你是一个AI图像提示词翻译专家。将用户提供的中文 Prompt 翻译为专业的英文图像生成提示词。

要求：
- 使用专业摄影和AI绘图术语
- 保留所有语义细节
- 强调画面质量、构图、光影
- 只输出英文翻译结果，不要输出任何解释"""

    # 使用自定义翻译提示词（如果有）
    custom_translate_prompt = model_config.get('system_prompt_translate', '').strip()
    if custom_translate_prompt:
        system_prompt = custom_translate_prompt

    provider = (model_config.get('provider') or 'deepseek').strip()
    api_key = (model_config.get('api_key') or '').strip()
    base_url = (model_config.get('base_url') or '').strip()
    model_name = (model_config.get('model_name') or '').strip()
    try:
        timeout_ms = int(model_config.get('timeout_ms', 30000))
        if timeout_ms <= 0:
            timeout_ms = 30000
    except (ValueError, TypeError):
        timeout_ms = 30000
    retry_count = model_config.get('retry_count', 2)

    if not api_key:
        return jsonify({"error": "API Key 未配置"}), 400

    if provider == 'deepseek':
        url = (base_url.rstrip('/') if base_url else 'https://api.deepseek.com') + '/chat/completions'
        model = model_name or DEFAULT_DEEPSEEK_MODEL
    else:
        url = (base_url.rstrip('/') if base_url else 'https://open.bigmodel.cn/api/paas/v4') + '/chat/completions'
        model = model_name or 'glm-4-flash'

    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json'
    }
    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': prompt_cn}
        ],
        'temperature': 0.3,
        'max_tokens': 300
    }

    last_error = None
    for i in range(max(retry_count, 1)):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=timeout_ms / 1000)
            if resp.status_code == 200:
                result = resp.json()
                choices = result.get('choices', [])
                if not choices or not choices[0].get('message', {}).get('content'):
                    last_error = f"大模型返回空结果: {str(result)[:200]}"
                    logger.warning(f"英文翻译返回异常: {last_error}")
                    continue
                content = choices[0]['message']['content'].strip()
                logger.info(f"英文翻译成功 (provider={provider})")
                return jsonify({"prompt_en": content})
            else:
                last_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
                logger.warning(f"英文翻译失败: {last_error}")
        except requests.exceptions.Timeout:
            last_error = "请求超时"
            logger.warning(f"英文翻译超时 (第{i+1}次)")
        except Exception as e:
            last_error = str(e)
            logger.warning(f"英文翻译异常: {last_error}")
        # 指数退避：重试前等待
        if i < retry_count - 1:
            wait = min(2 ** i, 10)
            logger.info(f"等待 {wait}s 后重试...")
            time.sleep(wait)

    return jsonify({"error": f"翻译失败: {last_error}"}), 500


# ---------- 素材库 API ----------

@app.route('/api/image-library', methods=['GET'])
def get_image_library():
    data = load_json('image_library.json')
    if data is None:
        # 首次访问，创建默认空分类
        default_categories = ['脸型库', '发型库', '动作库', '背景库', '服装库']
        data = {"categories": []}
        for name in default_categories:
            data['categories'].append({
                "id": gen_id('lib'),
                "name": name,
                "subcategories": []
            })
        save_json('image_library.json', data)
    else:
        # 向后兼容：旧数据有 items 字段，迁移到 subcategories
        needs_save = False
        for cat in data.get('categories', []):
            if 'items' in cat and 'subcategories' not in cat:
                cat['subcategories'] = [{
                    "id": gen_id('sub'),
                    "name": '默认',
                    "items": cat['items']
                }]
                del cat['items']
                needs_save = True
        if needs_save:
            save_json('image_library.json', data)
    return jsonify(data)


@app.route('/api/image-library', methods=['POST'])
def create_image_library_category():
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "分类名称不能为空"}), 400

    with data_lock:
        data = load_json('image_library.json')
        if data is None:
            data = {"categories": []}

        cat = {
            "id": gen_id('lib'),
            "name": name,
            "subcategories": []
        }
        data['categories'].append(cat)
        save_json('image_library.json', data)

    logger.info(f"新增素材分类: {name}")
    return jsonify(cat), 201


@app.route('/api/image-library/<cat_id>', methods=['PUT'])
def update_image_library_category(cat_id):
    body = request.get_json()
    name = body.get('name', '').strip()

    with data_lock:
        data = load_json('image_library.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for cat in data['categories']:
            if cat['id'] == cat_id:
                if name:
                    cat['name'] = name
                save_json('image_library.json', data)
                logger.info(f"更新素材分类: {cat_id} -> {name}")
                return jsonify(cat)

    return jsonify({"error": "分类不存在"}), 404


@app.route('/api/image-library/<cat_id>', methods=['DELETE'])
def delete_image_library_category(cat_id):
    with data_lock:
        data = load_json('image_library.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        data['categories'] = [c for c in data['categories'] if c['id'] != cat_id]
        save_json('image_library.json', data)

    logger.info(f"删除素材分类: {cat_id}")
    return jsonify({"success": True})


# ---------- 子分类 API ----------

@app.route('/api/image-library/<cat_id>/subcategories', methods=['POST'])
def create_subcategory(cat_id):
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "子分类名称不能为空"}), 400

    with data_lock:
        data = load_json('image_library.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for cat in data['categories']:
            if cat['id'] == cat_id:
                sub = {
                    "id": gen_id('sub'),
                    "name": name,
                    "items": []
                }
                cat.setdefault('subcategories', []).append(sub)
                save_json('image_library.json', data)
                logger.info(f"新增子分类: {name} (分类: {cat['name']})")
                return jsonify(sub), 201

    return jsonify({"error": "分类不存在"}), 404


@app.route('/api/image-library/<cat_id>/subcategories/<sub_id>', methods=['PUT'])
def update_subcategory(cat_id, sub_id):
    body = request.get_json()
    name = body.get('name', '').strip()

    with data_lock:
        data = load_json('image_library.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for cat in data['categories']:
            if cat['id'] == cat_id:
                for sub in cat.get('subcategories', []):
                    if sub['id'] == sub_id:
                        if name:
                            sub['name'] = name
                        save_json('image_library.json', data)
                        return jsonify(sub)

    return jsonify({"error": "子分类不存在"}), 404


@app.route('/api/image-library/<cat_id>/subcategories/<sub_id>', methods=['DELETE'])
def delete_subcategory(cat_id, sub_id):
    with data_lock:
        data = load_json('image_library.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for cat in data['categories']:
            if cat['id'] == cat_id:
                cat['subcategories'] = [s for s in cat.get('subcategories', []) if s['id'] != sub_id]
                save_json('image_library.json', data)
                logger.info(f"删除子分类: {sub_id}")
                return jsonify({"success": True})

    return jsonify({"error": "分类不存在"}), 404


# ---------- 子分类下条目 API ----------

@app.route('/api/image-library/<cat_id>/subcategories/<sub_id>/items', methods=['POST'])
def create_subcategory_item(cat_id, sub_id):
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "素材名称不能为空"}), 400

    with data_lock:
        data = load_json('image_library.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for cat in data['categories']:
            if cat['id'] == cat_id:
                for sub in cat.get('subcategories', []):
                    if sub['id'] == sub_id:
                        item = {
                            "id": gen_id('libitem'),
                            "name": name,
                            "image": body.get('image', '')
                        }
                        sub['items'].append(item)
                        save_json('image_library.json', data)
                        logger.info(f"新增素材: {name}")
                        return jsonify(item), 201

    return jsonify({"error": "子分类不存在"}), 404


@app.route('/api/image-library/<cat_id>/subcategories/<sub_id>/items/<item_id>', methods=['PUT'])
def update_subcategory_item(cat_id, sub_id, item_id):
    body = request.get_json()
    name = body.get('name', '').strip()
    image = body.get('image')

    with data_lock:
        data = load_json('image_library.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for cat in data['categories']:
            if cat['id'] == cat_id:
                for sub in cat.get('subcategories', []):
                    if sub['id'] == sub_id:
                        for item in sub['items']:
                            if item['id'] == item_id:
                                if name:
                                    item['name'] = name
                                if image is not None:
                                    item['image'] = image
                                save_json('image_library.json', data)
                                return jsonify(item)

    return jsonify({"error": "素材不存在"}), 404


@app.route('/api/image-library/<cat_id>/subcategories/<sub_id>/items/<item_id>', methods=['DELETE'])
def delete_subcategory_item(cat_id, sub_id, item_id):
    with data_lock:
        data = load_json('image_library.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for cat in data['categories']:
            if cat['id'] == cat_id:
                for sub in cat.get('subcategories', []):
                    if sub['id'] == sub_id:
                        sub['items'] = [i for i in sub['items'] if i['id'] != item_id]
                        save_json('image_library.json', data)
                        logger.info(f"删除素材: {item_id}")
                        return jsonify({"success": True})

    return jsonify({"error": "素材不存在"}), 404


# ---------- 图生图预设 API ----------

@app.route('/api/image-presets', methods=['GET'])
def get_image_presets():
    data = load_json('image_presets.json')
    if data is None:
        return jsonify({"presets": []})
    return jsonify(data)


@app.route('/api/image-presets', methods=['POST'])
def create_image_preset():
    body = request.get_json()
    name = body.get('name', '').strip()
    if not name:
        return jsonify({"error": "预设名称不能为空"}), 400

    with data_lock:
        data = load_json('image_presets.json')
        if data is None:
            data = {"presets": []}

        now = time.strftime('%Y-%m-%d %H:%M:%S')
        preset = {
            "id": gen_id('imgpre'),
            "name": name,
            "tags": body.get('tags', []),
            "prompt_cn": body.get('prompt_cn', ''),
            "prompt_en": body.get('prompt_en', ''),
            "prompt_lang": body.get('prompt_lang', 'en'),
            "images": body.get('images', []),
            "platform": body.get('platform', ''),
            "model": body.get('model', ''),
            "aspect_ratio": body.get('aspect_ratio', '3:4'),
            "effect_image": body.get('effect_image', ''),
            "created_at": now,
            "updated_at": now
        }
        data['presets'].append(preset)
        save_json('image_presets.json', data)

    logger.info(f"新增图生图预设: {name}")
    return jsonify(preset), 201


@app.route('/api/image-presets/<preset_id>', methods=['PUT'])
def update_image_preset(preset_id):
    body = request.get_json()
    with data_lock:
        data = load_json('image_presets.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        for p in data['presets']:
            if p['id'] == preset_id:
                if 'name' in body:
                    p['name'] = body['name'].strip()
                if 'prompt_cn' in body:
                    p['prompt_cn'] = body['prompt_cn']
                if 'prompt_en' in body:
                    p['prompt_en'] = body['prompt_en']
                if 'prompt_lang' in body:
                    p['prompt_lang'] = body['prompt_lang']
                if 'images' in body:
                    p['images'] = body['images']
                if 'tags' in body:
                    p['tags'] = body['tags']
                if 'platform' in body:
                    p['platform'] = body['platform']
                if 'model' in body:
                    p['model'] = body['model']
                if 'aspect_ratio' in body:
                    p['aspect_ratio'] = body['aspect_ratio']
                if 'effect_image' in body:
                    p['effect_image'] = body['effect_image']
                p['updated_at'] = time.strftime('%Y-%m-%d %H:%M:%S')
                save_json('image_presets.json', data)
                logger.info(f"更新图生图预设: {preset_id}")
                return jsonify(p)

    return jsonify({"error": "预设不存在"}), 404


@app.route('/api/image-presets/<preset_id>', methods=['DELETE'])
def delete_image_preset(preset_id):
    with data_lock:
        data = load_json('image_presets.json')
        if data is None:
            return jsonify({"error": "数据不存在"}), 404

        data['presets'] = [p for p in data['presets'] if p['id'] != preset_id]
        save_json('image_presets.json', data)

    logger.info(f"删除图生图预设: {preset_id}")
    return jsonify({"success": True})


# ========== RunningHub API 代理 ==========

def _rh_get_first(obj, keys):
    """Return the first non-empty value from a dict."""
    if not isinstance(obj, dict):
        return None
    for key in keys:
        value = obj.get(key)
        if value not in (None, ''):
            return value
    return None


def _rh_guess_output_type(url, fallback='png'):
    if not isinstance(url, str):
        return fallback
    clean = url.split('?', 1)[0].split('#', 1)[0].lower()
    ext = clean.rsplit('.', 1)[-1] if '.' in clean else ''
    return ext if ext in {'png', 'jpg', 'jpeg', 'webp', 'gif'} else fallback


def _rh_collect_results(value):
    """Normalize common RunningHub result shapes into [{url, outputType}]."""
    results = []

    def add_item(item):
        if isinstance(item, str):
            results.append({"url": item, "outputType": _rh_guess_output_type(item)})
            return
        if not isinstance(item, dict):
            return
        url = _rh_get_first(item, [
            'url', 'imageUrl', 'image_url', 'fileUrl', 'file_url',
            'downloadUrl', 'download_url', 'originUrl', 'origin_url',
            'resultUrl', 'result_url', 'outputUrl', 'output_url'
        ])
        if isinstance(url, str):
            output_type = item.get('outputType') or item.get('output_type') or item.get('type')
            results.append({"url": url, "outputType": output_type or _rh_guess_output_type(url)})

    def visit(node, depth=0):
        if depth > 3 or node is None:
            return
        if isinstance(node, list):
            for item in node:
                add_item(item)
            return
        if isinstance(node, str):
            add_item(node)
            return
        if not isinstance(node, dict):
            return
        add_item(node)
        for key in ('results', 'result', 'images', 'imageUrls', 'urls', 'outputs', 'output', 'files', 'data'):
            child = node.get(key)
            if child is not None and child is not node:
                visit(child, depth + 1)

    visit(value)
    seen = set()
    deduped = []
    for item in results:
        url = item.get('url')
        if url and url not in seen:
            seen.add(url)
            deduped.append(item)
    return deduped


def _rh_normalize_response(result, action):
    if not isinstance(result, dict):
        return {"raw": result}

    normalized = dict(result)
    data = result.get('data')
    containers = [result]
    if isinstance(data, dict):
        containers.append(data)

    task_id = None
    status = None
    error_message = None
    for container in containers:
        task_id = task_id or _rh_get_first(container, ['taskId', 'task_id', 'id'])
        status = status or _rh_get_first(container, ['status', 'taskStatus', 'task_status', 'state'])
        error_message = error_message or _rh_get_first(container, ['errorMessage', 'error_message', 'message', 'msg', 'error'])

    if task_id and not normalized.get('taskId'):
        normalized['taskId'] = task_id
    if status:
        status_upper = str(status).upper()
        if status_upper in {'COMPLETED', 'COMPLETE', 'FINISHED', 'SUCCEEDED', 'SUCCESS'}:
            status = 'SUCCESS'
        elif status_upper in {'FAIL', 'FAILED', 'ERROR', 'CANCELED', 'CANCELLED'}:
            status = 'FAILED'
        elif status_upper in {'QUEUE', 'QUEUED', 'IN_QUEUE', 'PENDING', 'WAITING'}:
            status = 'IN_QUEUE'
        elif status_upper in {'RUNNING', 'PROCESSING', 'GENERATING', 'STARTED'}:
            status = 'RUNNING'
    if status:
        normalized['status'] = status
    if error_message and not normalized.get('errorMessage'):
        normalized['errorMessage'] = str(error_message)
    if error_message and not normalized.get('taskId') and normalized.get('status') not in ('SUCCESS', 'RUNNING', 'IN_QUEUE'):
        normalized['status'] = 'FAILED'

    if action == 'query':
        results = _rh_collect_results(result)
        if results:
            normalized['results'] = results
            if not normalized.get('status') or normalized.get('status') in ('COMPLETED', 'COMPLETE', 'FINISHED', 'SUCCEEDED'):
                normalized['status'] = 'SUCCESS'

    code = normalized.get('code')
    ok_codes = {0, '0', 200, '200', None}
    if code not in ok_codes and not normalized.get('taskId') and normalized.get('status') not in ('SUCCESS', 'RUNNING', 'PENDING'):
        normalized['status'] = 'FAILED'

    return normalized


def _rh_log_summary(prefix, result):
    if not isinstance(result, dict):
        return f'{prefix} non_dict={type(result).__name__}'
    result_count = len(result.get('results') or []) if isinstance(result.get('results'), list) else 0
    keys = ','.join(list(result.keys())[:8])
    return (
        f'{prefix} http_status={result.get("_http_status")} '
        f'status={result.get("status")} code={result.get("code")} '
        f'taskId={result.get("taskId")} results={result_count} '
        f'msg={str(result.get("errorMessage") or result.get("message") or result.get("msg") or "")[:160]} '
        f'keys={keys}'
    )


@app.route('/api/rh-preflight', methods=['POST'])
@_local_only
def rh_preflight():
    """Validate a RunningHub Enterprise-Shared key without creating a paid task.

    RunningHub's official price-preview endpoint performs the same model parameter
    and permission checks as submission, but only returns an estimated price.
    """
    body = request.get_json(silent=True) or {}
    config = load_json('model_config.json') or {}
    supplied_key = str(body.get('api_key') or '').strip()
    if not supplied_key or '****' in supplied_key:
        supplied_key = str(config.get('rh_api_key') or '').strip()
    if not supplied_key:
        return jsonify({'success': False, 'message': '请先填写 RunningHub API Key'}), 400

    base_url = _normalize_runninghub_base_url(body.get('base_url') or config.get('rh_base_url'))
    ok, error, _ = _validate_url(base_url + '/', ALLOWED_API_DOMAINS)
    if not ok:
        return jsonify({'success': False, 'message': f'RunningHub 接口地址无效：{error}'}), 400
    model_id = str(body.get('model_id') or 'rhart-image-g-2-official/image-to-image').strip('/')
    if not re.fullmatch(r'[a-zA-Z0-9_.\-/]+', model_id):
        return jsonify({'success': False, 'message': 'RunningHub 模型地址无效'}), 400
    resolution = str(body.get('resolution') or '4k').lower()
    if resolution not in {'2k', '4k'}:
        resolution = '4k'

    # A schema-valid neutral image lets price-preview verify the image-to-image
    # endpoint. The endpoint does not generate an image and therefore is not billed.
    image_buffer = io.BytesIO()
    Image.new('RGB', (1024, 1536), (128, 128, 128)).save(image_buffer, 'JPEG', quality=35, optimize=True)
    image_uri = 'data:image/jpeg;base64,' + base64.b64encode(image_buffer.getvalue()).decode('ascii')
    preview_url = f'{base_url}/price-preview/{model_id}'
    params = {
        'imageUrls': [image_uri],
        'prompt': 'RunningHub API permission preflight',
        'resolution': resolution,
        'quality': 'high',
    }
    try:
        response = requests.post(
            preview_url,
            headers={'Authorization': f'Bearer {supplied_key}', 'Content-Type': 'application/json'},
            json=params,
            timeout=30,
        )
        try:
            result = response.json()
        except ValueError:
            return jsonify({'success': False, 'message': f'RunningHub 返回非JSON响应（HTTP {response.status_code}）'}), 502
    except requests.exceptions.Timeout:
        return jsonify({'success': False, 'message': 'RunningHub 权限预检超时，请稍后重试'}), 504
    except requests.RequestException as exc:
        logger.warning('[rh-preflight] request failed: %s', exc)
        return jsonify({'success': False, 'message': 'RunningHub 权限预检网络失败'}), 502

    error_text = ' '.join(str(result.get(key) or '') for key in ('code', 'errorCode', 'errorMessage', 'message', 'msg'))
    lowered_error = error_text.lower()
    if '1014' in error_text or 'enterprise-shared' in lowered_error or '企业级-共享' in error_text:
        return jsonify({
            'success': False,
            'error_code': 1014,
            'message': '当前Key不是企业级-共享 Key，不能调用标准模型 API；请在 RunningHub AI 站创建 Enterprise-Shared Key。',
            'charged': False,
            'task_created': False,
        }), 403
    estimated_price = result.get('estimatedPrice')
    if response.status_code == 200 and estimated_price is not None and not result.get('errorCode'):
        currency = str(result.get('currency') or '').strip() or 'CNY'
        account = {}
        try:
            parsed_base = urlparse(base_url)
            account_url = f'{parsed_base.scheme}://{parsed_base.netloc}/uc/openapi/accountStatus'
            account_response = requests.post(
                account_url,
                headers={'Authorization': f'Bearer {supplied_key}', 'Content-Type': 'application/json'},
                json={'apikey': supplied_key},
                timeout=20,
            )
            account_payload = account_response.json()
            if account_response.status_code == 200 and account_payload.get('code') in (0, '0'):
                account = account_payload.get('data') if isinstance(account_payload.get('data'), dict) else {}
        except Exception as exc:
            logger.warning('[rh-preflight] account status unavailable: %s', exc)
        return jsonify({
            'success': True,
            'message': f'企业共享模型权限验证通过；官方预计单次价格 {estimated_price} {currency}。本次未生图、未扣费。',
            'estimated_price': estimated_price,
            'currency': currency,
            'key_type_verified': 'enterprise-shared',
            'account': {
                'remain_money': account.get('remainMoney'),
                'remain_coins': account.get('remainCoins'),
                'current_tasks': account.get('currentTaskCounts'),
                'currency': account.get('currency'),
                'api_type': account.get('apiType'),
            } if account else None,
            'charged': False,
            'task_created': False,
        })
    public_error = error_text.strip() or f'HTTP {response.status_code}'
    return jsonify({
        'success': False,
        'message': f'RunningHub 权限预检未通过：{public_error[:240]}',
        'charged': False,
        'task_created': False,
    }), 400 if response.status_code < 500 else 502


@app.route('/api/rh-proxy', methods=['POST'])
def rh_proxy():
    """代理 RunningHub API 请求，避免前端 CORS 问题
    API Key 从服务端配置读取，前端无需传递真实密钥"""
    body = request.get_json(silent=True) or {}
    action = body.get('action') or request.form.get('action')  # 'submit', 'query' or 'upload'

    # 从服务端配置读取真实密钥（前端可能传遮蔽值，不可信）
    config = load_json('model_config.json') or {}
    rh_api_key = config.get('rh_api_key', '').strip()
    rh_base_url = _normalize_runninghub_base_url(config.get('rh_base_url'))
    # 允许前端覆盖 base_url（但不覆盖 api_key），需验证域名
    if body.get('base_url', '').strip():
        custom_base = _normalize_runninghub_base_url(body['base_url'])
        ok, err, _ = _validate_url(custom_base + '/', ALLOWED_API_DOMAINS)
        if ok:
            rh_base_url = custom_base
        else:
            logger.warning(f'[rh-proxy] base_url拦截: {err}')

    if not rh_api_key:
        return jsonify({"error": "RunningHub API Key 未配置"}), 400

    try:
        if action == 'submit':
            # 提交生成任务
            model_id = body.get('model_id', '')
            if not re.match(r'^[a-zA-Z0-9_\-/\.]+$', model_id):
                return jsonify({"error": "无效的 model_id"}), 400
            params = body.get('params', {})
            url = f"{rh_base_url}/{model_id}"

            headers = {
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {rh_api_key}'
            }
            resp = requests.post(url, headers=headers, json=params, timeout=30)
            result = _rh_normalize_response(resp.json(), 'submit')
            result['_http_status'] = resp.status_code
            logger.info(
                '[rh-proxy submit] model=%s image_count=%s resolution=%s aspect=%s prompt_len=%s %s',
                model_id,
                len(params.get('imageUrls') or []),
                params.get('resolution'),
                params.get('aspectRatio'),
                len(params.get('prompt') or ''),
                _rh_log_summary('', result)
            )
            result.pop('_http_status', None)
            return jsonify(result), resp.status_code

        elif action == 'query':
            # 查询任务状态
            task_id = body.get('task_id', '')
            if not task_id:
                return jsonify({"status": "FAILED", "errorMessage": "RunningHub taskId 为空，任务未成功提交"}), 400
            url = f"{rh_base_url}/query"

            headers = {
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {rh_api_key}'
            }
            resp = requests.post(url, headers=headers, json={"taskId": task_id}, timeout=30)
            result = _rh_normalize_response(resp.json(), 'query')
            result['_http_status'] = resp.status_code
            status = result.get('status')
            result_count = len(result.get('results') or []) if isinstance(result.get('results'), list) else 0
            if status in ('SUCCESS', 'FAILED') or result_count:
                logger.info('[rh-proxy query] taskId=%s %s', task_id, _rh_log_summary('', result))
            else:
                logger.debug('[rh-proxy query] taskId=%s %s', task_id, _rh_log_summary('', result))
            result.pop('_http_status', None)
            return jsonify(result), resp.status_code

        elif action == 'upload':
            # 上传文件到 RunningHub
            # upload action 需要multipart/form-data，从request.files和request.form获取参数
            if 'file' not in request.files:
                return jsonify({"error": "没有文件"}), 400
            file = request.files['file']
            rh_api_key_upload = rh_api_key  # 始终使用服务端配置的真实密钥
            rh_base_url_upload = rh_base_url  # 默认使用已验证的base_url
            custom_upload_base = request.form.get('base_url', '').strip().rstrip('/')
            if custom_upload_base:
                ok, err, _ = _validate_url(custom_upload_base + '/', ALLOWED_API_DOMAINS)
                if ok:
                    rh_base_url_upload = custom_upload_base
                else:
                    logger.warning(f'[rh-proxy upload] base_url拦截: {err}')
            url = f"{rh_base_url_upload}/media/upload/binary"
            headers = {
                'Authorization': f'Bearer {rh_api_key_upload}'
            }
            resp = requests.post(url, headers=headers, files={'file': (file.filename, file.stream, file.content_type)}, timeout=60)
            result = resp.json()
            return jsonify(result), resp.status_code

        else:
            return jsonify({"error": "未知操作"}), 400

    except requests.exceptions.Timeout:
        logger.warning('[rh-proxy] RunningHub请求超时 action=%s', action)
        return jsonify({"error": "请求超时"}), 504
    except ValueError as e:
        logger.error(f"RH代理响应不是JSON: {e}")
        return jsonify({"error": "RunningHub 返回了无法解析的响应"}), 502
    except Exception as e:
        logger.error(f"RH代理请求失败: {e}")
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/rh-download', methods=['POST'])
def rh_download():
    """下载 RunningHub 生成的图片并转发给前端"""
    body = request.get_json()
    url = body.get('url', '')
    if not url:
        return jsonify({"error": "URL不能为空"}), 400

    # SSRF防护：验证URL域名
    ok, err, _ = _validate_url(url, ALLOWED_IMAGE_DOMAINS)
    if not ok:
        logger.warning(f'[rh-download] SSRF拦截: {err}')
        return jsonify({"error": f"URL不允许: {err}"}), 403

    try:
        resp = requests.get(url, timeout=60)
        if resp.status_code == 200:
            from io import BytesIO
            # 自动转为JPG格式（保持像素和尺寸不变）
            jpg_data, jpg_ext = convert_to_jpg(resp.content)
            download_name = body.get('filename', 'AI生图.jpg')
            if jpg_ext:
                name_part, ext_part = os.path.splitext(download_name)
                if ext_part.lower() not in ('.jpg', '.jpeg'):
                    download_name = name_part + '.jpg'
            return send_file(
                BytesIO(jpg_data if jpg_ext else resp.content),
                mimetype='image/jpeg',
                as_attachment=True,
                download_name=download_name
            )
        else:
            return jsonify({"error": f"下载失败: HTTP {resp.status_code}"}), resp.status_code
    except Exception as e:
        logger.error(f'[rh-download] 异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


# ========== OpenAI-HK API 代理 ==========

@app.route('/api/oaihk-proxy', methods=['POST'])
def oaihk_proxy():
    """代理 OpenAI-HK API 请求，避免前端 CORS 问题
    API Key 从服务端配置读取，前端无需传递真实密钥"""
    body = request.get_json()
    action = body.get('action')

    # 从服务端配置读取真实密钥（前端可能传遮蔽值，不可信）
    config = load_json('model_config.json') or {}
    api_key = config.get('oaihk_api_key', '').strip()
    base_url = (config.get('oaihk_base_url') or 'https://api.openai-hk.com').rstrip('/')
    # 允许前端覆盖 base_url（但不覆盖 api_key），需验证域名
    if body.get('base_url', '').strip():
        custom_base = body['base_url'].strip().rstrip('/')
        ok, err, _ = _validate_url(custom_base + '/', ALLOWED_API_DOMAINS)
        if ok:
            base_url = custom_base
        else:
            logger.warning(f'[oaihk-proxy] base_url拦截: {err}')

    if not api_key:
        logger.warning('[oaihk] API Key 未配置')
        return jsonify({"error": "OpenAI-HK API Key 未配置"}), 400

    # 默认禁用系统代理，避免被本地代理/公司网关劫持导致Tunnel 403
    use_system_proxy = _to_bool(body.get('use_system_proxy', config.get('oaihk_use_system_proxy', False)), False)
    disable_system_proxy = not use_system_proxy

    logger.info(f'[oaihk] 代理请求: action={action}, base_url={base_url}, use_system_proxy={use_system_proxy}')

    try:
        if action == 'submit':
            endpoint = body.get('endpoint', '')
            model_id = body.get('model_id', '')
            params = body.get('params', {})
            headers = {
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {api_key}'
            }
            # 确保params中包含model字段（部分API需要）
            if model_id and 'model' not in params:
                params['model'] = model_id
            logger.info(
                f'[oaihk] 提交任务: endpoint=/{endpoint.lstrip("/")}, model={model_id}, '
                f'aspect_ratio={params.get("aspect_ratio")}, size={params.get("size")}, '
                f'prompt={params.get("prompt","")[:80]}..., image_urls={len(params.get("image_urls",[]))}张'
            )
            resp = _oaihk_request_with_fallback(
                'POST',
                base_url,
                endpoint,
                headers=headers,
                json=params,
                timeout=120,
                disable_system_proxy=disable_system_proxy
            )
            logger.info(f'[oaihk] 提交响应: HTTP {resp.status_code}, body={resp.text[:500]}')
            if resp.status_code != 200:
                logger.error(f'[oaihk] 提交失败: HTTP {resp.status_code} {resp.text[:300]}')
            try:
                result = resp.json()
            except Exception:
                logger.error(f'[oaihk] 响应非JSON: {resp.text[:300]}')
                return jsonify({"error": f"API返回非JSON响应 (HTTP {resp.status_code})", "detail": resp.text[:300]}), resp.status_code
            # 提取嵌套error对象中的message，确保前端能直接读取字符串
            if resp.status_code != 200 and 'error' in result:
                err = result['error']
                if isinstance(err, dict) and 'message' in err:
                    if err.get('code'):
                        result['code'] = err.get('code')
                    if err.get('type'):
                        result['type'] = err.get('type')
                    result['error'] = err['message']
            return jsonify(result), resp.status_code

        elif action == 'poll':
            poll_endpoint = body.get('poll_endpoint', '')
            request_id = body.get('request_id', '')
            if not request_id:
                logger.error('[oaihk] 轮询缺少request_id')
                return jsonify({"error": "轮询缺少request_id，请先成功提交任务"}), 400
            headers = {
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json'
            }
            endpoint = f"{poll_endpoint.rstrip('/')}/{request_id}"
            resp = _oaihk_request_with_fallback(
                'GET',
                base_url,
                endpoint,
                headers=headers,
                timeout=30,
                disable_system_proxy=disable_system_proxy
            )
            try:
                result = resp.json()
            except Exception:
                logger.error(f'[oaihk] 轮询响应非JSON: {resp.text[:300]}')
                return jsonify({"error": f"轮询返回非JSON响应 (HTTP {resp.status_code})"}), resp.status_code
            status = result.get('status', 'unknown')
            has_images = bool(result.get('images'))
            logger.info(f'[oaihk] 轮询: request_id={request_id}, status={status}, has_images={has_images}')
            # 提取嵌套error对象中的message
            if resp.status_code != 200 and 'error' in result:
                err = result['error']
                if isinstance(err, dict) and 'message' in err:
                    if err.get('code'):
                        result['code'] = err.get('code')
                    if err.get('type'):
                        result['type'] = err.get('type')
                    result['error'] = err['message']
            return jsonify(result), resp.status_code

        else:
            return jsonify({"error": "未知操作"}), 400

    except requests.exceptions.Timeout:
        logger.error(f'[oaihk] 请求超时: action={action}')
        return jsonify({"error": "请求超时"}), 504
    except Exception as e:
        logger.error(f'[oaihk] 代理请求异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/oaihk-gpt-image', methods=['POST'])
def oaihk_gpt_image():
    """代理 gpt-image-2 同步生图请求（文生图 + 图生图）
    文生图：前端传 JSON { prompt, size, quality, n }
    图生图：前端传 JSON { prompt, size, quality, n, image_base64_list }
    后端统一转发到 OpenAI-HK API，同步返回结果"""
    body = request.get_json(silent=True) or {}
    action = body.get('action', 'generations')  # generations 或 edits

    config = load_json('model_config.json') or {}
    api_key = config.get('oaihk_api_key', '').strip()
    base_url = (config.get('oaihk_base_url') or 'https://api.openai-hk.com').rstrip('/')
    if body.get('base_url', '').strip():
        custom_base = body['base_url'].strip().rstrip('/')
        ok, err, _ = _validate_url(custom_base + '/', ALLOWED_API_DOMAINS)
        if ok:
            base_url = custom_base
        else:
            logger.warning(f'[gpt-image] base_url拦截: {err}')

    use_system_proxy = _to_bool(body.get('use_system_proxy', config.get('oaihk_use_system_proxy', False)), False)
    disable_system_proxy = not use_system_proxy

    if not api_key:
        return jsonify({"error": "OpenAI-HK API Key 未配置"}), 400

    prompt = body.get('prompt', '')
    model = body.get('model', 'gpt-image-2')
    size = body.get('size', '1024x1024')
    quality = body.get('quality', 'low')
    n = max(1, min(int(body.get('n', 1)), 4))
    image_base64_list = body.get('image_base64_list', [])
    timeout_sec = int(body.get('timeout_sec') or config.get('oaihk_image_timeout_sec') or 240)

    logger.info(f'[gpt-image] action={action}, model={model}, prompt={prompt[:80]}..., images={len(image_base64_list)}, size={size}, quality={quality}, use_system_proxy={use_system_proxy}')
    if model in ('gpt-image-2-vip', 'gpt-image-2') and str(size).startswith('1024'):
        logger.warning(f'[gpt-image] 检测到GPT模型使用1K尺寸: model={model}, size={size}，请检查前端模型/比例映射')

    try:
        if action == 'generations' and len(image_base64_list) == 0:
            # 纯文生图：JSON POST
            headers = {
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {api_key}'
            }
            payload = {
                'model': model,
                'prompt': prompt,
                'n': n,
                'size': size,
                'quality': quality
            }
            resp = _oaihk_request_with_fallback(
                'POST',
                base_url,
                'v1/images/generations',
                headers=headers,
                json=payload,
                timeout=timeout_sec,
                disable_system_proxy=disable_system_proxy
            )
        else:
            # 图生图：multipart/form-data POST
            files = []
            form_data = {'model': model, 'prompt': prompt}
            if quality:
                form_data['quality'] = quality
            if size:
                form_data['size'] = size

            # 将 base64 图片转为临时文件用于 multipart 上传
            temp_files = []
            for idx, b64 in enumerate(image_base64_list):
                # 解码 base64
                if b64.startswith('data:'):
                    # data URI 格式：data:image/png;base64,xxxxx
                    header, b64_data = b64.split(',', 1)
                    mime = header.split(':')[1].split(';')[0]
                    ext = mime.split('/')[1] if '/' in mime else 'png'
                    if ext == 'jpeg':
                        ext = 'jpg'
                else:
                    b64_data = b64
                    ext = 'png'
                    mime = 'image/png'

                img_bytes = base64.b64decode(b64_data)
                tmp = tempfile.NamedTemporaryFile(suffix=f'.{ext}', delete=False)
                tmp.write(img_bytes)
                tmp.close()
                temp_files.append(tmp)
                # 兼容不同网关：单图优先用 image，多图再用 image[]
                field_name = 'image' if len(image_base64_list) == 1 else 'image[]'
                files.append((field_name, (f'reference_{idx}.{ext}', open(tmp.name, 'rb'), mime)))

            headers = {'Authorization': f'Bearer {api_key}'}
            resp = _oaihk_request_with_fallback(
                'POST',
                base_url,
                'v1/images/edits',
                headers=headers,
                data=form_data,
                files=files,
                timeout=timeout_sec,
                disable_system_proxy=disable_system_proxy
            )

            # 清理临时文件和文件句柄
            for f_tuple in files:
                f_tuple[1][1].close()
            for tmp in temp_files:
                try:
                    os.unlink(tmp.name)
                except OSError:
                    pass

        logger.info(f'[gpt-image] 响应: HTTP {resp.status_code}, body={resp.text[:500]}')

        try:
            result = resp.json()
        except Exception:
            logger.error(f'[gpt-image] 响应非JSON: {resp.text[:300]}')
            return jsonify({"error": f"API返回非JSON响应 (HTTP {resp.status_code})", "detail": resp.text[:300]}), resp.status_code

        if resp.status_code != 200 and 'error' in result:
            err = result['error']
            if isinstance(err, dict) and 'message' in err:
                if err.get('code'):
                    result['code'] = err.get('code')
                if err.get('type'):
                    result['type'] = err.get('type')
                result['error'] = err['message']

        # 只记录上游真实返图尺寸。禁止本地拉伸冒充原生 4K。
        if resp.status_code == 200 and model in ('gpt-image-2-vip', 'gpt-image-2'):
            result = _inspect_gpt_result_size(result, size)
        return jsonify(result), resp.status_code

    except requests.exceptions.Timeout:
        msg = f'OpenAI-HK GPT同步接口超时（已等待{timeout_sec}s仍未返回，通常是上游排队/网关卡住）'
        logger.error('[gpt-image] %s', msg)
        return jsonify({"error": msg, "code": "oaihk_gpt_timeout", "timeout_sec": timeout_sec}), 504
    except Exception as e:
        logger.error(f'[gpt-image] 异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


def _jsonify_route_result_to_data(result):
    status_code = 200
    response = result
    if isinstance(result, tuple):
        response = result[0]
        if len(result) > 1 and isinstance(result[1], int):
            status_code = result[1]
    try:
        data = response.get_json(silent=True)
    except Exception:
        data = None
    if data is None:
        data = {"error": "后台任务返回非JSON响应"}
    return data, status_code


def _prune_gpt_image_jobs_locked():
    now = time.time()
    stale_ids = [
        job_id for job_id, job in gpt_image_jobs.items()
        if job.get('status') in ('success', 'failed', 'cancelled') and now - float(job.get('finished_at') or job.get('created_at') or now) > 24 * 3600
    ]
    for job_id in stale_ids:
        gpt_image_jobs.pop(job_id, None)


def _run_gpt_image_background_job(job_id, body):
    with gpt_image_jobs_lock:
        job = gpt_image_jobs.get(job_id)
        if not job:
            return
        job['status'] = 'running'
        job['started_at'] = time.time()
    try:
        with app.test_request_context('/api/oaihk-gpt-image', method='POST', json=body):
            route_result = oaihk_gpt_image()
        data, status_code = _jsonify_route_result_to_data(route_result)
        with gpt_image_jobs_lock:
            job = gpt_image_jobs.get(job_id)
            if not job:
                return
            job['http_status'] = status_code
            job['finished_at'] = time.time()
            if 200 <= status_code < 300:
                job['status'] = 'success'
                job['data'] = data
            else:
                job['status'] = 'failed'
                job['error'] = data.get('error') or f'HTTP {status_code}'
                job['code'] = data.get('code') or ''
                job['data'] = data
    except Exception as e:
        logger.error(f'[gpt-image-job] 后台任务异常: job_id={job_id}, error={e}', exc_info=True)
        with gpt_image_jobs_lock:
            job = gpt_image_jobs.get(job_id)
            if job:
                job['status'] = 'failed'
                job['error'] = str(e) or '后台任务异常'
                job['finished_at'] = time.time()


@app.route('/api/oaihk-gpt-image-job', methods=['POST'])
def create_oaihk_gpt_image_job():
    body = request.get_json(silent=True) or {}
    job_id = uuid.uuid4().hex
    now = time.time()
    with gpt_image_jobs_lock:
        _prune_gpt_image_jobs_locked()
        gpt_image_jobs[job_id] = {
            'id': job_id,
            'status': 'queued',
            'created_at': now,
            'model': body.get('model', ''),
            'size': body.get('size', ''),
            'quality': body.get('quality', ''),
            'images': len(body.get('image_base64_list') or [])
        }
    gpt_image_job_executor.submit(_run_gpt_image_background_job, job_id, body)
    logger.info(f'[gpt-image-job] 已创建: job_id={job_id}, model={body.get("model")}, size={body.get("size")}, images={len(body.get("image_base64_list") or [])}')
    return jsonify({"job_id": job_id, "status": "queued", "max_workers": GPT_IMAGE_JOB_MAX_WORKERS})


@app.route('/api/oaihk-gpt-image-job/<job_id>', methods=['GET'])
def get_oaihk_gpt_image_job(job_id):
    with gpt_image_jobs_lock:
        job = gpt_image_jobs.get(job_id)
        if not job:
            return jsonify({"error": "任务不存在或已过期"}), 404
        payload = dict(job)
    return jsonify(payload)


@app.route('/api/preprocess-and-upload', methods=['POST'])
def preprocess_and_upload():
    """读取本地图片 → 按比例裁剪+缩放 → JPG Q90 → 上传tmpfiles图床 → 返回直链URL"""
    body = request.get_json(silent=True) or {}
    local_url = body.get('local_url', '')
    aspect_ratio = body.get('aspect_ratio', '3:4')  # e.g. "3:4"
    short_edge = int(body.get('short_edge', 1536))
    if short_edge <= 0:
        short_edge = 1536

    if not local_url:
        return jsonify({"error": "缺少local_url参数"}), 400

    # 解析本地路径
    abs_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), local_url.lstrip('/'))
    # 防止路径遍历
    base_dir = os.path.dirname(os.path.abspath(__file__))
    if not os.path.realpath(abs_path).startswith(os.path.realpath(base_dir)):
        return jsonify({"error": "非法路径"}), 400
    if not os.path.exists(abs_path):
        logger.error(f'[preprocess] 本地图片不存在: {abs_path}')
        return jsonify({"error": f"本地图片不存在: {local_url}"}), 404

    logger.info(f'[preprocess] 开始处理: {local_url}, 比例={aspect_ratio}, 短边={short_edge}')

    try:
        # 1. 打开并处理图片
        img = Image.open(abs_path)
        img = ImageOps.exif_transpose(img)

        w, h = img.size

        # 2. 智能裁剪：仅在比例偏差>2%时才裁剪（前端已裁剪的图不会重复裁）
        img = _smart_crop_to_ratio(img, aspect_ratio)

        # 3. 短边缩放
        w, h = img.size
        se = min(w, h)
        if se != short_edge:
            scale = short_edge / se
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

        # 4. 转JPG Q90
        if img.mode in ('RGBA', 'P', 'LA'):
            img = img.convert('RGB')
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=90, optimize=True)
        buf.seek(0)
        file_bytes = buf.read()
        logger.info(f'[preprocess] 处理完成: {w}x{h} → {img.size}, 大小={len(file_bytes)//1024}KB')

        # 5. 上传到 tmpfiles.org
        filename = f"ref_{int(time.time())}_{uuid.uuid4().hex[:6]}.jpg"
        resp = requests.post(
            'https://tmpfiles.org/api/v1/upload',
            files={'file': (filename, file_bytes, 'image/jpeg')},
            timeout=60
        )
        logger.info(f'[preprocess] 图床响应: HTTP {resp.status_code}, body={resp.text[:500]}')

        if resp.status_code != 200:
            logger.error(f'[preprocess] 图床返回非200: {resp.status_code}')
            return jsonify({"error": f"图床返回HTTP {resp.status_code}", "detail": resp.text[:300]}), 502

        result = resp.json()
        if result.get('data', {}).get('url'):
            original_url = result['data']['url']
            direct_url = original_url.replace('tmpfiles.org/', 'tmpfiles.org/dl/')
            result['data']['direct_url'] = direct_url
            logger.info(f'[preprocess] 上传成功, 直链: {direct_url}')
        else:
            logger.warning(f'[preprocess] 响应中无URL: {result}')

        return jsonify(result), 200

    except Exception as e:
        logger.error(f'[preprocess] 处理失败: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/preprocess-to-base64', methods=['POST'])
def preprocess_to_base64():
    """读取本地图片 → 按比例裁剪 → 按模型短边缩放 → 转base64 data URI"""
    body = request.get_json(silent=True) or {}
    local_url = body.get('local_url', '')
    aspect_ratio = body.get('aspect_ratio', '3:4')
    short_edge = int(body.get('short_edge', 0))  # 0表示不缩放（兼容旧调用）

    if not local_url:
        return jsonify({"error": "缺少local_url参数"}), 400

    abs_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), local_url.lstrip('/'))
    # 防止路径遍历
    base_dir = os.path.dirname(os.path.abspath(__file__))
    if not os.path.realpath(abs_path).startswith(os.path.realpath(base_dir)):
        return jsonify({"error": "非法路径"}), 400
    if not os.path.exists(abs_path):
        logger.error(f'[preprocess-b64] 本地图片不存在: {abs_path}')
        return jsonify({"error": f"本地图片不存在: {local_url}"}), 404

    logger.info(f'[preprocess-b64] 开始处理: {local_url}, 比例={aspect_ratio}, 短边={short_edge}')

    try:
        img = Image.open(abs_path)
        img = ImageOps.exif_transpose(img)

        w, h = img.size

        # 智能裁剪：仅在比例偏差>2%时才裁剪
        img = _smart_crop_to_ratio(img, aspect_ratio)

        # 按模型短边缩放（官方要求：flash=1024, 2k=1536, 4k=2048）
        w, h = img.size
        if short_edge > 0:
            se = min(w, h)
            if se != short_edge:
                scale = short_edge / se
                img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
                logger.info(f'[preprocess-b64] 缩放: {w}x{h} → {img.size}, 短边={short_edge}')

        # 编码为JPEG
        if img.mode in ('RGBA', 'P', 'LA'):
            img = img.convert('RGB')
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=95, optimize=True)
        file_bytes = buf.getvalue()

        size_kb = len(file_bytes) // 1024
        logger.info(f'[preprocess-b64] 处理完成: {w}x{h}, 大小={size_kb}KB')

        # 转base64 data URI
        b64_str = base64.b64encode(file_bytes).decode('ascii')
        data_uri = f'data:image/jpeg;base64,{b64_str}'
        logger.info(f'[preprocess-b64] base64生成完成, 长度={len(data_uri)}')

        return jsonify({"data": {"data_uri": data_uri, "size_kb": size_kb}}), 200

    except Exception as e:
        logger.error(f'[preprocess-b64] 处理失败: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/tmpfiles-upload', methods=['POST'])
def tmpfiles_upload():
    """代理上传图片到 tmpfiles.org 图床，返回公网直链URL"""
    if 'file' not in request.files:
        logger.warning('[tmpfiles] 上传请求中没有file字段')
        return jsonify({"error": "没有文件"}), 400
    file = request.files['file']
    filename = file.filename or 'upload.png'
    logger.info(f'[tmpfiles] 收到图床上传请求: {filename}, content_type={file.content_type}')

    try:
        # 先将文件内容读到内存，避免stream透传问题
        file_bytes = file.read()
        if len(file_bytes) == 0:
            logger.error('[tmpfiles] 文件内容为空')
            return jsonify({"error": "文件内容为空"}), 400
        logger.info(f'[tmpfiles] 文件大小: {len(file_bytes)} bytes')

        resp = requests.post(
            'https://tmpfiles.org/api/v1/upload',
            files={'file': (filename, file_bytes, file.content_type or 'image/png')},
            timeout=60
        )
        logger.info(f'[tmpfiles] 图床响应: HTTP {resp.status_code}, body={resp.text[:500]}')

        if resp.status_code != 200:
            logger.error(f'[tmpfiles] 图床返回非200: {resp.status_code} {resp.text[:300]}')
            return jsonify({"error": f"图床返回HTTP {resp.status_code}", "detail": resp.text[:300]}), 502

        result = resp.json()
        # 将 tmpfiles.org/ 替换为 tmpfiles.org/dl/ 得到图片直链
        if result.get('data', {}).get('url'):
            original_url = result['data']['url']
            direct_url = original_url.replace('tmpfiles.org/', 'tmpfiles.org/dl/')
            result['data']['direct_url'] = direct_url
            logger.info(f'[tmpfiles] 上传成功, 直链: {direct_url}')
        else:
            logger.warning(f'[tmpfiles] 响应中无URL: {result}')

        return jsonify(result), resp.status_code
    except requests.exceptions.Timeout:
        logger.error('[tmpfiles] 图床上传超时(60s)')
        return jsonify({"error": "图床上传超时"}), 504
    except Exception as e:
        logger.error(f'[tmpfiles] 图床上传异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


# ---------- 4.2 Parallel image preprocessing and upload ----------

def _preprocess_one_image(local_url, aspect_ratio='3:4', short_edge=1536):
    """Process a single local image: crop + scale + encode as base64 data URI.
    Returns (data_uri, error_string). Used for parallel batch processing."""
    try:
        abs_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), local_url.lstrip('/'))
        base_dir = os.path.dirname(os.path.abspath(__file__))
        if not os.path.realpath(abs_path).startswith(os.path.realpath(base_dir)):
            return None, "非法路径"
        if not os.path.exists(abs_path):
            return None, f"本地图片不存在: {local_url}"

        img = Image.open(abs_path)
        img = ImageOps.exif_transpose(img)
        w, h = img.size

        # 智能裁剪：仅在比例偏差>2%时才裁剪
        img = _smart_crop_to_ratio(img, aspect_ratio)

        # Scale by short edge
        w, h = img.size
        if short_edge > 0:
            se = min(w, h)
            if se != short_edge:
                scale = short_edge / se
                img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

        # Encode as JPEG
        if img.mode in ('RGBA', 'P', 'LA'):
            img = img.convert('RGB')
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=95, optimize=True)
        file_bytes = buf.getvalue()

        b64_str = base64.b64encode(file_bytes).decode('ascii')
        data_uri = f'data:image/jpeg;base64,{b64_str}'
        return data_uri, None

    except Exception as e:
        return None, str(e)


@app.route('/api/preprocess-batch', methods=['POST'])
def preprocess_batch():
    """4.2: Parallel batch preprocessing of multiple images.
    Accepts a list of local_urls and processes them concurrently using ThreadPoolExecutor.
    Returns list of {data_uri, error} in original order."""
    body = request.get_json(silent=True) or {}
    local_urls = body.get('local_urls', [])
    aspect_ratio = body.get('aspect_ratio', '3:4')
    short_edge = int(body.get('short_edge', 1536))

    if not local_urls:
        return jsonify({"error": "缺少local_urls参数"}), 400

    results = [None] * len(local_urls)

    def _process_one(index, url):
        data_uri, error = _preprocess_one_image(url, aspect_ratio, short_edge)
        return index, data_uri, error

    # Process in parallel (max 5 workers)
    max_workers = min(5, len(local_urls))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(_process_one, i, url): i for i, url in enumerate(local_urls)}
        for future in as_completed(futures):
            i = futures[future]
            try:
                idx, data_uri, error = future.result()
                results[idx] = {"data_uri": data_uri, "error": error, "size_kb": len(data_uri) // 1024 if data_uri else 0}
            except Exception as e:
                results[i] = {"data_uri": None, "error": str(e), "size_kb": 0}

    logger.info(f'[preprocess-batch] 并行处理{len(local_urls)}张图片完成')
    return jsonify({"results": results}), 200


# ========== 结果图片代理下载 ==========

@app.route('/api/download-image', methods=['POST'])
def download_image():
    """代理下载结果图片（v3.fal.media等可能被墙的域名），返回base64给前端"""
    body = request.get_json(silent=True) or {}
    image_url = body.get('url', '')
    if not image_url:
        return jsonify({"error": "缺少url参数"}), 400

    # SSRF防护：验证URL域名
    ok, err, _ = _validate_url(image_url, ALLOWED_IMAGE_DOMAINS)
    if not ok:
        logger.warning(f'[download-proxy] SSRF拦截: {err}')
        return jsonify({"error": f"URL不允许: {err}"}), 403

    logger.info(f'[download-proxy] 代理下载: {image_url[:100]}')

    try:
        resp = requests.get(image_url, timeout=60, stream=True)
        if resp.status_code != 200:
            logger.error(f'[download-proxy] 下载失败: HTTP {resp.status_code}')
            return jsonify({"error": f"下载失败: HTTP {resp.status_code}"}), 502

        content_type = resp.headers.get('Content-Type', 'image/png')
        # 限制最大30MB，使用BytesIO避免内存碎片
        max_size = 30 * 1024 * 1024
        buf = io.BytesIO()
        for chunk in resp.iter_content(chunk_size=8192):
            buf.write(chunk)
            if buf.tell() > max_size:
                return jsonify({"error": "图片超过30MB限制"}), 413
        data = buf.getvalue()

        # 展示代理必须保留平台返回的原始字节：避免 PNG 4K 被二次 JPEG 压缩，
        # 同时保留 Google C2PA / SynthID 等来源元数据。另存 JPG 走专用下载接口。

        width = None
        height = None
        try:
            with Image.open(io.BytesIO(data)) as result_img:
                width, height = result_img.size
        except Exception as size_err:
            logger.warning(f'[download-proxy] 无法读取结果图尺寸: {size_err}')

        b64_str = base64.b64encode(data).decode('ascii')
        data_uri = f'data:{content_type};base64,{b64_str}'
        logger.info(f'[download-proxy] 下载完成: {len(data)//1024}KB, type={content_type}')

        return jsonify({"data": {
            "data_uri": data_uri,
            "size_kb": len(data) // 1024,
            "content_type": content_type,
            "width": width,
            "height": height,
        }}), 200

    except requests.exceptions.Timeout:
        logger.error('[download-proxy] 下载超时')
        return jsonify({"error": "下载超时"}), 504
    except Exception as e:
        logger.error(f'[download-proxy] 下载异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500

@app.route('/api/save-image-to-path', methods=['POST'])
def save_image_to_path():
    """将图片下载保存到用户指定的本地路径。

    默认用于自动入库，会创建日期子文件夹；手动另存可传 use_date_folder=False，
    避免用户选择 2026-05-25 文件夹后又生成 2026-05-25/2026-05-26 这类嵌套目录。
    """
    body = request.get_json(silent=True) or {}
    image_url = body.get('url', '')
    base_path = body.get('path', '')
    filename = body.get('filename', '')
    use_date_folder = body.get('use_date_folder', True)

    if not image_url:
        return jsonify({"error": "缺少图片URL"}), 400
    if not base_path:
        return jsonify({"error": "缺少保存路径"}), 400

    # 路径安全：验证base_path在允许范围内
    ok, err = _validate_base_path(base_path)
    if not ok:
        logger.warning(f'[save-image] 路径拦截: {err}')
        return jsonify({"error": f"路径不允许: {err}"}), 403

    # 展开 ~ 为用户主目录
    base_path = os.path.expanduser(base_path)

    # 自动入库写入日期子文件夹；手动另存写入用户选择的文件夹本身
    target_dir = os.path.join(base_path, datetime.now().strftime('%Y-%m-%d')) if use_date_folder else base_path

    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as e:
        return jsonify({"error": f"无法创建目录 {target_dir}: {e}"}), 400

    # 生成文件名
    if not filename:
        timestamp = datetime.now().strftime('%H%M%S')
        filename = f"AI生图_{timestamp}.jpg"

    # 确保文件名扩展名为 .jpg（下载时统一转JPG）
    name_part, ext_part = os.path.splitext(filename)
    if ext_part.lower() not in ('.jpg', '.jpeg'):
        filename = name_part + '.jpg'

    # 确保文件名安全
    filename = re.sub(r'[^\w\-.]', '_', filename)
    filepath = os.path.join(target_dir, filename)

    # 避免文件名冲突：如果文件已存在，加序号
    if os.path.exists(filepath):
        name, ext = os.path.splitext(filename)
        counter = 1
        while os.path.exists(os.path.join(target_dir, f"{name}_{counter}{ext}")):
            counter += 1
        filepath = os.path.join(target_dir, f"{name}_{counter}{ext}")

    logger.info(f'[save-image] 下载图片到: {filepath}')

    try:
        if image_url.startswith('data:'):
            # 支持前端 data URI（拆图/HK 回传常见），避免被 URL 协议校验拦截
            m = re.match(r'^data:([^;,]+)?(;base64)?,(.*)$', image_url, re.IGNORECASE | re.DOTALL)
            if not m:
                return jsonify({"error": "data URL 格式无效"}), 400
            is_base64 = bool(m.group(2))
            payload = m.group(3) or ''
            if is_base64:
                data = base64.b64decode(payload, validate=True)
            else:
                from urllib.parse import unquote_to_bytes
                data = unquote_to_bytes(payload)
            if len(data) > 30 * 1024 * 1024:
                return jsonify({"error": "图片超过30MB限制"}), 413
        elif image_url.startswith('/api/gallery-image?'):
            from urllib.parse import parse_qs, urlparse, unquote
            qs = parse_qs(urlparse(image_url).query or '')
            raw_path = (qs.get('path') or [''])[0]
            safe_path = _safe_path(unquote(raw_path))
            if not safe_path or not os.path.isfile(safe_path):
                return jsonify({"error": "图库源文件不存在"}), 404
            with open(safe_path, 'rb') as f:
                data = f.read()
        elif image_url.startswith('/static/'):
            local_path = os.path.join(BASE_DIR, image_url.lstrip('/'))
            real_local = os.path.realpath(local_path)
            if not real_local.startswith(os.path.realpath(BASE_DIR) + os.sep):
                return jsonify({"error": "路径不允许"}), 403
            if not os.path.isfile(real_local):
                return jsonify({"error": "本地图片不存在"}), 404
            with open(real_local, 'rb') as f:
                data = f.read()
        else:
            # SSRF防护：仅对远程URL做域名校验
            ok, err, _ = _validate_url(image_url, ALLOWED_IMAGE_DOMAINS)
            if not ok:
                logger.warning(f'[save-image] SSRF拦截: {err}')
                return jsonify({"error": f"URL不允许: {err}"}), 403
            resp = requests.get(image_url, timeout=(15, 60), stream=True)
            if resp.status_code != 200:
                logger.error(f'[save-image] 下载失败: HTTP {resp.status_code}')
                return jsonify({"error": f"下载图片失败: HTTP {resp.status_code}"}), 502

            # 限制最大30MB，使用BytesIO避免内存碎片
            max_size = 30 * 1024 * 1024
            buf = io.BytesIO()
            for chunk in resp.iter_content(chunk_size=8192):
                buf.write(chunk)
                if buf.tell() > max_size:
                    return jsonify({"error": "图片超过30MB限制"}), 413
            data = buf.getvalue()

        # 自动转为JPG格式（保持像素和尺寸不变，方便Mac Finder预览大图）
        jpg_data, jpg_ext = convert_to_jpg(data)
        if jpg_ext:
            data = jpg_data
            # 确保文件名扩展名为 .jpg
            name_part, ext_part = os.path.splitext(filename)
            if ext_part.lower() not in ('.jpg', '.jpeg'):
                filename = name_part + '.jpg'
                filepath = os.path.join(target_dir, filename)

        with open(filepath, 'wb') as f:
            f.write(data)

        logger.info(f'[save-image] 保存成功: {filepath} ({len(data)//1024}KB)')
        return jsonify({
            "ok": True,
            "path": filepath,
            "size_kb": len(data) // 1024
        }), 200

    except requests.exceptions.Timeout:
        logger.error('[save-image] 下载超时')
        return jsonify({"error": "下载图片超时"}), 504
    except requests.exceptions.RequestException as e:
        logger.error(f'[save-image] 远程下载失败: {e}')
        return jsonify({"error": f"远程图片下载失败: {e}"}), 502
    except Exception as e:
        logger.error(f'[save-image] 保存异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/backup-result-image', methods=['POST'])
def backup_result_image():
    """将生成的结果图片备份到本地（转JPG），返回本地URL供前端持久化引用。
    图片保存到用户配置的备份路径下的日期子文件夹，
    同时在 static/images/backup/ 下创建副本供Web访问。"""
    body = request.get_json(silent=True) or {}
    image_url = body.get('url', '')
    filename = body.get('filename', '')

    if not image_url:
        return jsonify({"error": "缺少图片URL"}), 400

    # 优先使用前端传入的队列专属路径，否则回退到全局配置
    base_path = body.get('download_path', '').strip()
    if not base_path:
        config = load_json('model_config.json') or {}
        base_path = config.get('rh_download_path', '').strip() or '~/Downloads/AI生图/'
    base_path = os.path.expanduser(base_path)

    # 路径安全校验
    ok, err = _validate_base_path(base_path)
    if not ok:
        return jsonify({"error": f"备份路径不允许: {err}"}), 403

    # 创建日期子文件夹
    date_folder = datetime.now().strftime('%Y-%m-%d')
    target_dir = os.path.join(base_path, date_folder)
    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as e:
        return jsonify({"error": f"无法创建目录: {e}"}), 400

    # 生成文件名
    if not filename:
        timestamp = datetime.now().strftime('%H%M%S')
        filename = f"AI生图_{timestamp}.jpg"
    name_part, ext_part = os.path.splitext(filename)
    if ext_part.lower() not in ('.jpg', '.jpeg', '.png', '.webp'):
        filename = name_part + '.jpg'
    filename = re.sub(r'[^\w\-.]', '_', filename)
    filepath = os.path.join(target_dir, filename)

    # 避免文件名冲突
    if os.path.exists(filepath):
        name, ext = os.path.splitext(filename)
        counter = 1
        while os.path.exists(os.path.join(target_dir, f"{name}_{counter}{ext}")):
            counter += 1
        filepath = os.path.join(target_dir, f"{name}_{counter}{ext}")

    # 下载图片
    try:
        if image_url.startswith('data:'):
            # 支持前端 data URI（gpt-image 常返回 b64_json）
            m = re.match(r'^data:([^;,]+)?(;base64)?,(.*)$', image_url, re.IGNORECASE | re.DOTALL)
            if not m:
                return jsonify({"error": "data URL 格式无效"}), 400
            is_base64 = bool(m.group(2))
            payload = m.group(3) or ''
            if is_base64:
                data = base64.b64decode(payload, validate=True)
            else:
                from urllib.parse import unquote_to_bytes
                data = unquote_to_bytes(payload)
            if len(data) > 30 * 1024 * 1024:
                return jsonify({"error": "图片超过30MB限制"}), 413
        elif image_url.startswith('/api/gallery-image?'):
            from urllib.parse import parse_qs, urlparse, unquote
            qs = parse_qs(urlparse(image_url).query or '')
            raw_path = (qs.get('path') or [''])[0]
            safe_path = _safe_path(unquote(raw_path))
            if not safe_path or not os.path.isfile(safe_path):
                return jsonify({"error": "图库源文件不存在"}), 404
            with open(safe_path, 'rb') as f:
                data = f.read()
        elif image_url.startswith('/'):
            base_dir = os.path.dirname(os.path.abspath(__file__))
            local_path = os.path.join(base_dir, image_url.lstrip('/'))
            if not os.path.realpath(local_path).startswith(os.path.realpath(base_dir)):
                return jsonify({"error": "路径不允许"}), 403
            if not os.path.exists(local_path):
                return jsonify({"error": "文件不存在"}), 404
            with open(local_path, 'rb') as f:
                data = f.read()
        else:
            ok, err, _ = _validate_url(image_url, ALLOWED_IMAGE_DOMAINS)
            if not ok:
                return jsonify({"error": f"URL不允许: {err}"}), 403
            resp = requests.get(image_url, timeout=(15, 60), stream=True)
            if resp.status_code != 200:
                return jsonify({"error": f"下载失败: HTTP {resp.status_code}"}), 502
            max_size = 30 * 1024 * 1024
            buf = io.BytesIO()
            for chunk in resp.iter_content(chunk_size=8192):
                buf.write(chunk)
                if buf.tell() > max_size:
                    return jsonify({"error": "图片超过30MB限制"}), 413
            data = buf.getvalue()

        # 转JPG
        jpg_data, jpg_ext = convert_to_jpg(data)
        if jpg_data:
            data = jpg_data
            name_part2, ext_part2 = os.path.splitext(os.path.basename(filepath))
            if ext_part2.lower() not in ('.jpg', '.jpeg'):
                filepath = os.path.splitext(filepath)[0] + '.jpg'

        with open(filepath, 'wb') as f:
            f.write(data)

        # 通过 /api/gallery-image 代理访问，不再复制到 static/images/backup/
        # 这样避免双倍存储：图片只保存在下载目录一份
        from urllib.parse import quote
        local_url = f'/api/gallery-image?path={quote(filepath, safe="")}'
        logger.info(f'[backup] 图片备份成功: {filepath} ({len(data)//1024}KB)')
        return jsonify({
            "ok": True,
            "path": filepath,
            "local_url": local_url,
            "size_kb": len(data) // 1024
        }), 200

    except requests.exceptions.Timeout:
        return jsonify({"error": "下载超时"}), 504
    except requests.exceptions.RequestException as e:
        logger.error(f'[backup] 远程下载失败: {e}')
        return jsonify({"error": f"远程图片下载失败: {e}"}), 502
    except Exception as e:
        logger.error(f'[backup] 备份异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/crop-grid-image', methods=['POST'])
def crop_grid_image():
    """将九宫格图片（3列×3行）按编号裁剪，返回裁剪后的图片URL列表。
    编号映射: 1=左上, 2=中上, 3=右上, 4=左中, 5=正中, 6=右中, 7=左下, 8=中下, 9=右下"""
    body = request.get_json(silent=True) or {}
    image_url = body.get('image_url', '')
    numbers = body.get('numbers', [])

    if not image_url:
        return jsonify({"error": "缺少图片URL"}), 400
    if not numbers or not isinstance(numbers, list):
        return jsonify({"error": "缺少编号列表"}), 400

    # 校验编号范围
    for n in numbers:
        if not isinstance(n, int) or n < 1 or n > 9:
            return jsonify({"error": f"编号必须在1-9之间，收到: {n}"}), 400

    # 读取图片
    try:
        if image_url.startswith('/'):
            base_dir = os.path.dirname(os.path.abspath(__file__))
            local_path = os.path.join(base_dir, image_url.lstrip('/'))
            if not os.path.realpath(local_path).startswith(os.path.realpath(base_dir)):
                return jsonify({"error": "路径不允许"}), 403
            if not os.path.exists(local_path):
                return jsonify({"error": "文件不存在"}), 404
            with open(local_path, 'rb') as f:
                data = f.read()
        else:
            ok, err, _ = _validate_url(image_url, ALLOWED_IMAGE_DOMAINS)
            if not ok:
                return jsonify({"error": f"URL不允许: {err}"}), 403
            resp = requests.get(image_url, timeout=120, stream=True)
            if resp.status_code != 200:
                return jsonify({"error": f"下载失败: HTTP {resp.status_code}"}), 502
            max_size = 30 * 1024 * 1024
            buf = io.BytesIO()
            for chunk in resp.iter_content(chunk_size=8192):
                buf.write(chunk)
                if buf.tell() > max_size:
                    return jsonify({"error": "图片超过30MB限制"}), 413
            data = buf.getvalue()
    except requests.exceptions.Timeout:
        return jsonify({"error": "下载超时"}), 504
    except Exception as e:
        return jsonify({"error": f"读取图片失败: {e}"}), 500

    # 裁剪
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        if img.mode != 'RGB':
            img = img.convert('RGB')

        img_w, img_h = img.size
        if img_w < 3 or img_h < 3:
            return jsonify({"error": f"图片尺寸太小({img_w}x{img_h})，无法裁剪"}), 400
        cell_w = img_w // 3
        cell_h = img_h // 3

        results = []
        for n in numbers:
            row = (n - 1) // 3
            col = (n - 1) % 3
            left = col * cell_w
            top = row * cell_h
            right = left + cell_w
            bottom = top + cell_h

            cropped = img.crop((left, top, right, bottom))

            # 转JPG
            buf_crop = io.BytesIO()
            cropped.save(buf_crop, format='JPEG', quality=95, optimize=True)
            jpg_data = buf_crop.getvalue()

            # 保存到 static/images/
            fname = f"{gen_id('img')}.jpg"
            fpath = os.path.join(IMAGES_DIR, fname)
            with open(fpath, 'wb') as f:
                f.write(jpg_data)

            results.append({
                "number": n,
                "url": f"/static/images/{fname}"
            })

        logger.info(f'[crop-grid] 裁剪完成: {len(results)}张, 编号={numbers}')
        return jsonify({"ok": True, "images": results}), 200

    except Exception as e:
        logger.error(f'[crop-grid] 裁剪异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/free-crop-image', methods=['POST'])
def api_free_crop_image():
    """自由裁剪图片：根据比例坐标裁剪，x/y/w/h 均为 0~1 的比例值"""
    body = request.get_json(silent=True) or {}
    image_url = body.get('image_url', '')
    x = float(body.get('x', 0))
    y = float(body.get('y', 0))
    w = float(body.get('w', 0))
    h = float(body.get('h', 0))

    if not image_url or w <= 0 or h <= 0:
        return jsonify({"ok": False, "error": "参数无效"}), 400

    # 读取图片（复用 crop-grid-image 的读取逻辑）
    try:
        if image_url.startswith('/'):
            base_dir = os.path.dirname(os.path.abspath(__file__))
            local_path = os.path.join(base_dir, image_url.lstrip('/'))
            if not os.path.realpath(local_path).startswith(os.path.realpath(base_dir)):
                return jsonify({"ok": False, "error": "路径不允许"}), 403
            if not os.path.exists(local_path):
                return jsonify({"ok": False, "error": "文件不存在"}), 404
            with open(local_path, 'rb') as f:
                img_data = f.read()
        else:
            ok, err, _ = _validate_url(image_url, ALLOWED_IMAGE_DOMAINS)
            if not ok:
                return jsonify({"ok": False, "error": f"URL不允许: {err}"}), 403
            resp = requests.get(image_url, timeout=120, stream=True)
            if resp.status_code != 200:
                return jsonify({"ok": False, "error": f"下载失败: HTTP {resp.status_code}"}), 502
            buf = io.BytesIO()
            for chunk in resp.iter_content(chunk_size=8192):
                buf.write(chunk)
                if buf.tell() > 10 * 1024 * 1024:
                    return jsonify({"ok": False, "error": "图片超过10MB限制"}), 413
            img_data = buf.getvalue()
    except Exception as e:
        return jsonify({"ok": False, "error": f"读取图片失败: {e}"}), 500

    try:
        img = Image.open(io.BytesIO(img_data))
        img = ImageOps.exif_transpose(img)
        if img.mode != 'RGB':
            img = img.convert('RGB')

        img_w, img_h = img.size
        # 比例坐标 → 像素坐标
        px = max(0, int(x * img_w))
        py = max(0, int(y * img_h))
        pw = max(1, min(int(w * img_w), img_w - px))
        ph = max(1, min(int(h * img_h), img_h - py))

        cropped = img.crop((px, py, px + pw, py + ph))

        buf_crop = io.BytesIO()
        cropped.save(buf_crop, format='JPEG', quality=95, optimize=True)
        jpg_data = buf_crop.getvalue()

        fname = f"{gen_id('img')}.jpg"
        fpath = os.path.join(IMAGES_DIR, fname)
        with open(fpath, 'wb') as f:
            f.write(jpg_data)

        return jsonify({"ok": True, "url": f"/static/images/{fname}"}), 200
    except Exception as e:
        logger.error(f'[free-crop] 裁剪异常: {e}', exc_info=True)
        return jsonify({"ok": False, "error": "服务内部错误"}), 500


# ========== DWPose 姿态提取 ==========

@app.route('/api/dwpose-process', methods=['POST'])
def api_dwpose_process():
    """DWPose 姿态提取：接收图片 URL，返回骨骼姿势图 URL"""
    global _dwpose_model
    data = request.get_json(silent=True) or {}
    image_url = data.get('imageUrl', '')
    if not image_url:
        return jsonify({'error': '未提供图片URL'}), 400

    def _resolve_dwpose_source_path(raw_url):
        text = (raw_url or '').strip()
        if not text:
            return None
        if text.startswith('/api/gallery-image?'):
            try:
                from urllib.parse import parse_qs, urlparse, unquote
                q = parse_qs(urlparse(text).query or '')
                src_path = (q.get('path') or [''])[0]
                return _safe_path(unquote(src_path)) if src_path else None
            except Exception:
                return None
        if text.startswith('/static/images/') or text.startswith('static/images/'):
            return _safe_path(os.path.join(BASE_DIR, text.lstrip('/')))
        if text.startswith('/') or text.startswith('~'):
            return _safe_path(text)
        return None

    local_abs_path = _resolve_dwpose_source_path(image_url)
    if not local_abs_path or not os.path.exists(local_abs_path):
        return jsonify({'error': '图片文件不存在'}), 404

    # 计算源图 MD5 作为缓存 key
    with open(local_abs_path, 'rb') as f:
        file_hash = hashlib.md5(f.read()).hexdigest()[:12]

    cache_filename = f'dwpose_{file_hash}.jpg'
    cache_path = os.path.join(DWPOSE_CACHE_DIR, cache_filename)
    cache_url = f'/static/images/dwpose_cache/{cache_filename}'

    # 缓存命中
    if os.path.exists(cache_path):
        logger.info(f'[dwpose] 缓存命中: {cache_filename}')
        return jsonify({'poseImageUrl': cache_url, 'cached': True})

    # 加锁处理（防止并发重复处理）
    if not _dwpose_lock.acquire(blocking=False):
        return jsonify({'error': 'DWPose 正在处理中，请稍后再试'}), 429

    try:
        # 懒加载模型
        if _dwpose_model is None:
            logger.info('[dwpose] 首次加载 DWPose 模型...')
            from dwpose import Wholebody, custom_hf_download, DWPOSE_MODEL_NAME
            det_path = resolve_dwpose_model_file(
                DWPOSE_MODEL_NAME,
                'yolox_l.onnx',
                custom_hf_download
            )
            pose_path = resolve_dwpose_model_file(
                DWPOSE_MODEL_NAME,
                'dw-ll_ucoco_384.onnx',
                custom_hf_download
            )
            logger.info(f'[dwpose] 模型路径: det={det_path}, pose={pose_path}')
            _dwpose_model = Wholebody(det_model_path=det_path, pose_model_path=pose_path)
            logger.info('[dwpose] DWPose 模型加载完成')

        # 再次检查缓存（等待锁期间可能已被其他请求处理）
        if os.path.exists(cache_path):
            return jsonify({'poseImageUrl': cache_url, 'cached': True})

        # 处理图片
        import numpy as np
        from dwpose import Wholebody, draw_poses

        img = Image.open(local_abs_path).convert('RGB')
        img_np = np.array(img)
        height, width = img_np.shape[:2]

        keypoints_info = _dwpose_model(img_np)
        if keypoints_info is None or (hasattr(keypoints_info, 'shape') and keypoints_info.shape[0] == 0):
            del img, img_np, keypoints_info
            try:
                import torch, gc
                torch.mps.empty_cache()
                gc.collect()
            except:
                pass
            return jsonify({'error': '未检测到人体姿态'}), 400

        pose_results = Wholebody.format_result(keypoints_info)
        pose_img = draw_poses(pose_results, height, width, draw_body=True, draw_hand=True, draw_face=True)
        pose_pil = Image.fromarray(pose_img)
        pose_pil.save(cache_path, 'JPEG', quality=90)

        logger.info(f'[dwpose] 姿态图已生成: {cache_filename}')

        # 内存清理
        del img, img_np, keypoints_info, pose_results, pose_img, pose_pil
        try:
            import torch, gc
            torch.mps.empty_cache()
            gc.collect()
        except:
            pass

        return jsonify({'poseImageUrl': cache_url, 'cached': False})

    except Exception as e:
        logger.error(f'[dwpose] 处理失败: {e}', exc_info=True)
        try:
            import torch, gc
            torch.mps.empty_cache()
            gc.collect()
        except:
            pass
        return jsonify({'error': f'DWPose 处理失败: {str(e)}'}), 500

    finally:
        _dwpose_lock.release()


@app.route('/api/log-action', methods=['POST'])
def log_action():
    """接收前端上报的用户操作日志"""
    body = request.get_json(silent=True) or {}
    action = body.get('action', 'unknown')
    detail = body.get('detail', {})
    # 格式化日志：[分类] 描述 | 详情JSON
    detail_str = json.dumps(detail, ensure_ascii=False) if detail else ''
    logger.info(f'[{action}] {body.get("msg", "")} | {detail_str}')
    return jsonify({"ok": True})


@app.route('/api/logs', methods=['GET'])
@_local_only
def get_logs():
    """返回最近N行日志，供调试查看（仅限本地访问）"""
    # IP检查已由 @_local_only 装饰器处理
    lines = int(request.args.get('lines', 200))
    level_filter = request.args.get('level', '').upper()
    log_file = os.path.join(LOG_DIR, 'app.log')
    if not os.path.exists(log_file):
        return jsonify({"logs": [], "total": 0})
    try:
        with open(log_file, 'r', encoding='utf-8', errors='replace') as f:
            all_lines = f.readlines()
        if level_filter:
            filtered = [l.rstrip() for l in all_lines if f'[{level_filter}]' in l]
        else:
            filtered = [l.rstrip() for l in all_lines]
        recent = filtered[-lines:] if len(filtered) > lines else filtered
        return jsonify({"logs": recent, "total": len(filtered)})
    except Exception as e:
        logger.error(f'[logs] 读取异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


# ========== 外部导出：系统剪贴板 + 临时文件夹 ==========

last_temp_dir = None

@app.route('/api/copy-images-to-sys', methods=['POST'])
def copy_images_to_sys_clipboard():
    """方案一：利用 osascript 将多张本地图片写入 macOS 剪贴板"""
    try:
        image_urls = request.json.get('images', [])
        if not image_urls:
            return jsonify({'success': False, 'message': '没有图片'})

        abs_paths = []
        base_dir = os.path.dirname(os.path.abspath(__file__))
        for url in image_urls:
            local_path = os.path.join(base_dir, url.lstrip('/'))
            # 防止路径遍历
            if not os.path.realpath(local_path).startswith(os.path.realpath(base_dir)):
                continue
            if os.path.exists(local_path):
                abs_paths.append(local_path)

        if not abs_paths:
            return jsonify({'success': False, 'message': '文件不存在'})

        # 用 AppleScript 将多个文件写入系统剪贴板
        # 转义路径中的双引号和反斜杠，防止 AppleScript 注入
        def _escape_applescript_path(p):
            p = p.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n').replace('\r', '\\r')
            return p
        applescript_parts = []
        for p in abs_paths:
            safe_p = _escape_applescript_path(p)
            applescript_parts.append(f'POSIX file "{safe_p}"')
        applescript_files = ", ".join(applescript_parts)
        script = f'set the clipboard to {{{applescript_files}}}'
        subprocess.run(['osascript', '-e', script], check=True)
        logger.info(f"已将{len(abs_paths)}张图片写入系统剪贴板")
        return jsonify({'success': True, 'count': len(abs_paths)})
    except Exception as e:
        logger.error(f"写入系统剪贴板失败: {e}")
        return jsonify({'success': False, 'error': '服务内部错误'})


@app.route('/api/reveal-temp-images', methods=['POST'])
def reveal_temp_images():
    """方案二：将选中的分散图片复制到临时文件夹，并打开访达"""
    global last_temp_dir
    try:
        image_urls = request.json.get('images', [])
        if not image_urls:
            return jsonify({'success': False, 'message': '没有图片'})

        # 清理上一次的临时文件夹
        if last_temp_dir and os.path.exists(last_temp_dir):
            shutil.rmtree(last_temp_dir, ignore_errors=True)

        # 创建新的临时文件夹
        temp_dir = tempfile.mkdtemp(prefix="ai_export_images_")
        last_temp_dir = temp_dir

        base_dir = os.path.dirname(os.path.abspath(__file__))
        for i, url in enumerate(image_urls):
            local_path = os.path.join(base_dir, url.lstrip('/'))
            # 防止路径遍历
            if not os.path.realpath(local_path).startswith(os.path.realpath(base_dir)):
                continue
            if os.path.exists(local_path):
                original_filename = os.path.basename(local_path)
                safe_filename = f"{i+1:02d}_{original_filename}"
                dest_path = os.path.join(temp_dir, safe_filename)
                shutil.copy2(local_path, dest_path)

        # 打开访达
        subprocess.run(['open', temp_dir])
        logger.info(f"已将{len(image_urls)}张图片聚合到 {temp_dir} 并打开访达")
        return jsonify({'success': True, 'count': len(image_urls), 'path': temp_dir})
    except Exception as e:
        logger.error(f"聚合图片失败: {e}")
        return jsonify({'success': False, 'error': '服务内部错误'})


# ========== API 用量追踪 ==========

def _log_usage(model, task_id='', cost=0.0, platform=''):
    """记录一次生成用量"""
    today = datetime.now().strftime('%Y-%m-%d')
    with data_lock:
        data = load_json('usage_log.json')
        if data is None:
            data = {"entries": [], "daily": {}}
        entry = {
            "date": today,
            "time": datetime.now().strftime('%H:%M:%S'),
            "model": model,
            "platform": platform,
            "task_id": task_id,
            "cost": cost
        }
        data['entries'].append(entry)
        # 保留最近200条
        if len(data['entries']) > 200:
            data['entries'] = data['entries'][-200:]
        # 更新每日汇总
        daily = data.setdefault('daily', {})
        day_key = today
        if day_key not in daily:
            daily[day_key] = {"count": 0, "cost": 0.0, "models": {}}
        daily[day_key]["count"] += 1
        daily[day_key]["cost"] += cost
        model_key = f"{platform}/{model}" if platform else model
        daily[day_key]["models"][model_key] = daily[day_key]["models"].get(model_key, 0) + 1
        # 清理超过90天的日汇总
        cutoff = (datetime.now() - timedelta(days=90)).strftime('%Y-%m-%d')
        for k in list(daily.keys()):
            if k < cutoff:
                del daily[k]
        save_json('usage_log.json', data)


@app.route('/api/usage', methods=['GET'])
def get_usage():
    """返回今日/本月用量汇总 + 最近10条记录"""
    data = load_json('usage_log.json')
    if data is None:
        data = {"entries": [], "daily": {}}

    today = datetime.now().strftime('%Y-%m-%d')
    this_month = datetime.now().strftime('%Y-%m')

    daily = data.get('daily', {})
    entries = data.get('entries', [])

    # 今日汇总
    today_data = daily.get(today, {"count": 0, "cost": 0.0, "models": {}})
    today_count = today_data.get("count", 0)
    today_cost = today_data.get("cost", 0.0)

    # 本月汇总
    month_count = 0
    month_cost = 0.0
    for day_key, day_data in daily.items():
        if day_key.startswith(this_month):
            month_count += day_data.get("count", 0)
            month_cost += day_data.get("cost", 0.0)

    # 最近10条
    recent = entries[-10:] if entries else []
    # 反转使最新在前
    recent = list(reversed(recent))

    return jsonify({
        "today": {"count": today_count, "cost": today_cost, "models": today_data.get("models", {})},
        "month": {"count": month_count, "cost": month_cost},
        "recent": recent
    })


@app.route('/api/log-usage', methods=['POST'])
def log_usage():
    """前端上报一次生成用量"""
    body = request.get_json(silent=True) or {}
    model = body.get('model', 'unknown')
    task_id = body.get('task_id', '')
    cost = float(body.get('cost', 0.0))
    platform = body.get('platform', '')
    _log_usage(model, task_id, cost, platform)
    return jsonify({"ok": True})


# ========== 自动更新系统 ==========

def _get_local_version():
    """读取本地版本号"""
    vpath = os.path.join(BASE_DIR, 'version.json')
    if os.path.exists(vpath):
        try:
            with open(vpath, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {"version": "0.0.0", "name": "样片工厂", "repo": "lengjueqi-coder/TTyangpian"}


@app.route('/api/check-update')
def check_update():
    """检查 GitHub 是否有新版本"""
    local = _get_local_version()
    repo = local.get('repo', 'lengjueqi-coder/TTyangpian')
    local_ver = local.get('version', '0.0.0')

    try:
        # 请求 GitHub API 获取最新 release
        api_url = f"https://api.github.com/repos/{repo}/releases/latest"
        headers = {"Accept": "application/vnd.github+json"}
        resp = requests.get(api_url, headers=headers, timeout=10)
        if resp.status_code != 200:
            return jsonify({"has_update": False, "error": f"GitHub API 返回 {resp.status_code}"})

        release = resp.json()
        remote_ver = release.get('tag_name', '').lstrip('v')
        if not remote_ver:
            return jsonify({"has_update": False, "error": "无法获取远程版本号"})

        # 比较版本号（简单字符串比较，格式 x.y.z）
        def ver_tuple(v):
            parts = v.split('.')
            return tuple(int(p) for p in parts if p.isdigit())

        has_update = ver_tuple(remote_ver) > ver_tuple(local_ver)

        # 找 zip asset
        download_url = None
        for asset in release.get('assets', []):
            if asset.get('name', '').endswith('.zip'):
                download_url = asset['browser_download_url']
                break

        return jsonify({
            "has_update": has_update,
            "local_version": local_ver,
            "remote_version": remote_ver,
            "download_url": download_url,
            "release_notes": release.get('body', ''),
            "html_url": release.get('html_url', '')
        })
    except Exception as e:
        logger.error(f'[check-update] 异常: {e}', exc_info=True)
        return jsonify({"has_update": False, "error": "服务内部错误"})


# 更新状态（内存中）
_update_state = {"running": False, "progress": "", "error": None}
_update_state_lock = threading.Lock()


@app.route('/api/do-update', methods=['POST'])
@_local_only
def do_update():
    """执行一键更新：下载最新 release zip → 解压覆盖 → 重启"""
    global _update_state
    with _update_state_lock:
        if _update_state["running"]:
            return jsonify({"ok": False, "error": "更新正在进行中"})

    body = request.get_json(silent=True) or {}
    download_url = body.get('download_url', '')
    if not download_url:
        return jsonify({"ok": False, "error": "缺少下载链接"})

    # 安全：限制下载URL必须来自GitHub
    ok, err, _ = _validate_url(download_url, ALLOWED_UPDATE_DOMAINS)
    if not ok:
        logger.warning(f'[更新] URL拦截: {err}')
        return jsonify({"ok": False, "error": f"下载链接不安全: {err}"})

    def _set_update_state(**kwargs):
        global _update_state
        with _update_state_lock:
            _update_state.update(kwargs)

    def _run_update():
        global _update_state
        with _update_state_lock:
            _update_state = {"running": True, "progress": "正在下载...", "error": None}
        try:
            # 1. 下载 zip（含重试）
            zip_path = os.path.join(tempfile.gettempdir(), 'TTyangpian_update.zip')
            download_success = False
            last_error = None
            
            for attempt in range(3):
                try:
                    _set_update_state(progress=f"正在下载更新包... (尝试 {attempt + 1}/3)")
                    logger.info(f"[更新] 开始下载 (尝试 {attempt + 1}/3): {download_url}")
                    
                    # 增加超时：10秒连接超时，600秒读取超时
                    resp = requests.get(download_url, timeout=(10, 600), stream=True)
                    resp.raise_for_status()
                    
                    with open(zip_path, 'wb') as f:
                        for chunk in resp.iter_content(chunk_size=8192):
                            f.write(chunk)
                    
                    download_success = True
                    logger.info(f"[更新] 下载完成: {zip_path}")
                    break
                    
                except requests.exceptions.RequestException as e:
                    last_error = e
                    logger.warning(f"[更新] 下载失败 (尝试 {attempt + 1}/3): {e}")
                    if os.path.exists(zip_path):
                        os.remove(zip_path)
                    if attempt < 2:
                        time.sleep(3)  # 等待3秒后重试
            
            if not download_success:
                raise last_error

            # After writing zip_path, verify SHA256 if available
            try:
                checksum_url = download_url + '.sha256'
                checksum_resp = _http_request('GET', checksum_url, timeout=10)
                if checksum_resp.status_code == 200:
                    expected_hash = checksum_resp.text.strip().split()[0]
                    actual_hash = _file_sha256(zip_path)
                    if actual_hash != expected_hash:
                        raise ValueError(f"更新包SHA256校验失败")
            except Exception as e:
                logger.warning(f'[更新] SHA256校验跳过: {e}')

            # 2. 解压到临时目录
            _set_update_state(progress="正在解压...")
            extract_dir = os.path.join(tempfile.gettempdir(), 'TTyangpian_update_extracted')
            if os.path.exists(extract_dir):
                shutil.rmtree(extract_dir, ignore_errors=True)
            with zipfile.ZipFile(zip_path, 'r') as zf:
                _safe_extract_zip(zf, extract_dir)
            logger.info(f"[更新] 解压完成: {extract_dir}")

            # 找到实际项目目录（zip 内可能有一层根目录）
            entries = os.listdir(extract_dir)
            if len(entries) == 1 and os.path.isdir(os.path.join(extract_dir, entries[0])):
                src_dir = os.path.join(extract_dir, entries[0])
            else:
                src_dir = extract_dir

            # 3. 覆盖本地文件（保留用户数据）
            _set_update_state(progress="正在替换文件...")
            preserve = {'venv', 'data', 'logs', 'backups', '__pycache__', '.DS_Store', '.claude', '.git', 'static'}
            for item in os.listdir(src_dir):
                if item in preserve:
                    continue
                src = os.path.join(src_dir, item)
                dst = os.path.join(BASE_DIR, item)
                if os.path.isdir(src):
                    if os.path.exists(dst):
                        shutil.rmtree(dst, ignore_errors=True)
                    shutil.copytree(src, dst)
                else:
                    shutil.copy2(src, dst)
            logger.info("[更新] 文件替换完成")

            # 4. 清理
            try:
                os.remove(zip_path)
                shutil.rmtree(extract_dir, ignore_errors=True)
            except Exception:
                pass

            # 5. 重启
            _set_update_state(progress="更新完成，正在重启...")
            logger.info("[更新] 准备重启服务")

            # 用新进程替换当前进程
            import sys
            time.sleep(1)
            os.execv(sys.executable, [sys.executable] + sys.argv)

        except Exception as e:
            _set_update_state(error=str(e), running=False)
            logger.error(f"[更新] 失败: {e}")

    # 在后台线程执行更新
    threading.Thread(target=_run_update, daemon=True).start()
    return jsonify({"ok": True})


@app.route('/api/update-status')
def update_status():
    """查询更新进度"""
    return jsonify(_update_state)


@app.route('/api/open-download-folder', methods=['POST'])
def open_download_folder():
    """打开API生图保存文件夹"""
    body = request.get_json(silent=True) or {}
    base_path = body.get('path', '~/Downloads/AI生图/')
    base_path = os.path.expanduser(base_path)

    # 路径安全校验：只允许打开用户目录下的路径
    abs_base = os.path.abspath(base_path)
    home_dir = os.path.expanduser('~')
    if not abs_base.startswith(home_dir):
        return jsonify({"error": "路径必须在用户主目录下"}), 400

    # 创建日期子文件夹（与save-image-to-path一致）
    date_folder = datetime.now().strftime('%Y-%m-%d')
    target_dir = os.path.join(base_path, date_folder)

    # 校验最终路径也在用户目录下
    abs_target = os.path.abspath(target_dir)
    if not abs_target.startswith(home_dir):
        return jsonify({"error": "路径必须在用户主目录下"}), 400

    try:
        os.makedirs(target_dir, exist_ok=True)
    except OSError as e:
        return jsonify({"error": f"无法创建目录: {e}"}), 400

    try:
        subprocess.run(['open', abs_target], check=True)
        logger.info(f'[open-folder] 打开文件夹: {abs_target}')
        return jsonify({"ok": True, "path": abs_target})
    except Exception as e:
        logger.error(f'[open-folder] 异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/select-folder', methods=['POST'])
def select_folder():
    """打开 macOS 原生文件夹选择器，返回用户选择的路径
    使用 AppleScript choose folder 对话框（系统自带 Tcl/Tk 8.5 与 macOS 15.7 不兼容会崩溃，不能用 tkinter）"""
    try:
        body = request.get_json(silent=True) or {}
        # 优先使用前端传入的路径，否则回退到全局配置
        initial_dir = body.get('initial_dir', '').strip()
        if not initial_dir:
            config = load_json('model_config.json') or {}
            initial_dir = config.get('rh_download_path', '').strip()
        if initial_dir:
            initial_dir = os.path.expanduser(initial_dir)
            if not os.path.isdir(initial_dir):
                initial_dir = os.path.expanduser('~')
        else:
            initial_dir = os.path.expanduser('~')

        # 使用 AppleScript 的 choose folder 对话框，不依赖 tkinter
        # 需要转义路径中的特殊字符以防 AppleScript 语法错误
        escaped_dir = initial_dir.replace('\\', '\\\\').replace('"', '\\"')
        applescript = f'''
        set defaultLocation to POSIX file "{escaped_dir}"
        try
            set chosenFolder to choose folder with prompt "选择并授权样片工厂使用这个文件夹" default location defaultLocation
            return POSIX path of chosenFolder
        on error number -128
            return ""
        end try
        '''
        result = subprocess.run(
            ['osascript', '-e', applescript],
            capture_output=True, text=True, timeout=120
        )
        selected = result.stdout.strip()

        if selected:
            real_selected = os.path.realpath(selected)
            if not _is_allowed_user_storage_path(real_selected):
                return jsonify({"error": "该路径不在允许的存储位置内。允许：用户主目录、/Volumes/盘名（外置盘/U盘，含盘根目录）、/Users/Shared、/Applications、/Library/Application Support、/tmp"}), 400
            return jsonify({"ok": True, "path": selected})
        else:
            return jsonify({"ok": False, "path": None})
    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "path": None})
    except Exception as e:
        logger.error(f'[select-folder] 异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


# ========== 电商批量生图 ==========

ECOMMERCE_IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp'}
ECOMMERCE_FINAL_TASK_STATES = {'accepted', 'manual_review', 'cancelled'}


def _is_allowed_user_storage_path(path):
    """检查路径是否位于允许用户存储数据的位置。

    策略：白名单 + 系统敏感目录黑名单。
    用户通过 AppleScript choose folder 选择目录时已触发 macOS TCC 授权，
    所以这里只做基本安全过滤，避免误操作系统目录。

    允许：
      - 用户主目录 ~/ 及其子目录
      - /Volumes/盘名 及其子目录（盘根目录也允许，外置盘/U盘常见使用方式）
      - /Users/Shared 及其子目录（用户间共享目录）
      - /Applications 及其子目录
      - /Library/Application Support 及其子目录
      - /tmp、/var/tmp 及其子目录

    禁止：/Volumes 根目录本身、系统敏感目录（/System、/usr、/bin、/sbin、/etc、
          /private/etc、/private/var、/dev、/proc、/sys）、/Library 根目录的直接子目录
          （/Library/Application Support 例外）。
    """
    real = os.path.realpath(os.path.expanduser(str(path or '')))
    if not real or not os.path.isabs(real):
        return False

    home = os.path.realpath(os.path.expanduser('~'))
    if real == home or real.startswith(home + os.sep):
        return True

    volumes = os.path.realpath('/Volumes')
    if real.startswith(volumes + os.sep):
        # /Volumes/盘名 至少 3 段（['', 'Volumes', '盘名']）；盘根目录也允许
        parts = real.split(os.sep)
        if len(parts) >= 3 and parts[2]:
            return True
        return False

    users_shared = os.path.realpath('/Users/Shared')
    if real == users_shared or real.startswith(users_shared + os.sep):
        return True

    applications = os.path.realpath('/Applications')
    if real == applications or real.startswith(applications + os.sep):
        return True

    # /Library 整体禁止，但 /Library/Application Support 例外（部分用户会把数据存这里）
    app_support = os.path.realpath('/Library/Application Support')
    if real == app_support or real.startswith(app_support + os.sep):
        return True

    for tmp_path in ('/tmp', '/var/tmp'):
        tmp_real = os.path.realpath(tmp_path)
        if real == tmp_real or real.startswith(tmp_real + os.sep):
            return True

    return False


def _ecommerce_default_store():
    return {'version': 2, 'templates': [], 'batches': [], 'waste_scans': [], 'rerun_batches': []}


def _ecommerce_load_store():
    data = load_json(ECOMMERCE_DATA_FILE)
    if not isinstance(data, dict):
        data = _ecommerce_default_store()
    if not isinstance(data.get('templates'), list):
        data['templates'] = []
    if not isinstance(data.get('batches'), list):
        data['batches'] = []
    if not isinstance(data.get('waste_scans'), list):
        data['waste_scans'] = []
    if not isinstance(data.get('rerun_batches'), list):
        data['rerun_batches'] = []
    return data


def _ecommerce_save_store(data):
    # 自动归档：保留最近 50 个批次 + 所有未完成状态的批次
    # 超过的旧批次（已 completed/cancelled）会被自动清理元数据，但保留磁盘文件
    batches = data.get('batches', [])
    if len(batches) > 50:
        ACTIVE_STATES = {'draft', 'running', 'resuming', 'paused', 'interrupted'}
        keep, archive = [], []
        # 优先保留活跃批次和最近 50 个批次
        for b in batches:
            if b.get('status') in ACTIVE_STATES:
                keep.append(b)
            else:
                archive.append(b)
        # 保留最近 N 个批次（按 updated_at 降序）
        archive.sort(key=lambda b: b.get('updated_at') or b.get('created_at') or '', reverse=True)
        kept_archive = archive[:50 - len(keep)]
        dropped = archive[50 - len(keep):]
        if dropped:
            logger.info(f'[ecommerce-store] 自动归档 {len(dropped)} 个旧批次元数据（磁盘文件保留）')
            for b in dropped:
                logger.debug(f'[ecommerce-store] 归档批次: {b.get("id")} {b.get("name")} ({b.get("status")})')
        data['batches'] = keep + kept_archive
    save_json(ECOMMERCE_DATA_FILE, data)


def _ecommerce_cleanup_temp_dirs(max_age_days=30):
    """清理超过 max_age_days 天的临时目录文件。

    清理范围：
    - _重做临时参考图/：每次重做累积，30天自动清理
    - _重做历史/：每次重做累积原图副本，30天自动清理
    - _质检缓存/：质检残留，30天自动清理
    - _人工补齐暂存/：人工补齐残留，30天自动清理
    - _历史误归档隔离/：误归档隔离，30天自动清理

    成品目录（_成品输出/）和批次缓存（_运行缓存/_生成样本备份/、_废片预览备份/）
    不在此函数清理范围，因为它们是用户的最终产物，需要用户手动管理。
    """
    if not max_age_days or max_age_days <= 0:
        return 0
    import time as _time
    _app_root = os.path.dirname(os.path.abspath(__file__))
    cache_root = os.path.expanduser(os.path.join(_app_root, '_运行缓存'))
    if not os.path.isdir(cache_root):
        return 0
    cleaned = 0
    cutoff = _time.time() - max_age_days * 86400
    temp_subdirs = ['_重做临时参考图', '_重做历史', '_质检缓存', '_人工补齐暂存', '_历史误归档隔离']
    for subdir in temp_subdirs:
        target = os.path.join(cache_root, subdir)
        if not os.path.isdir(target):
            continue
        try:
            for entry in os.listdir(target):
                entry_path = os.path.join(target, entry)
                try:
                    mtime = os.path.getmtime(entry_path)
                except OSError:
                    continue
                if mtime < cutoff:
                    try:
                        if os.path.isdir(entry_path):
                            shutil.rmtree(entry_path, ignore_errors=True)
                        else:
                            os.remove(entry_path)
                        cleaned += 1
                    except OSError as exc:
                        logger.warning(f'[ecommerce-cleanup] 清理 {entry_path} 失败: {exc}')
        except OSError as exc:
            logger.warning(f'[ecommerce-cleanup] 扫描 {target} 失败: {exc}')
    if cleaned:
        logger.info(f'[ecommerce-cleanup] 自动清理 {cleaned} 个超过 {max_age_days} 天的临时文件')
    return cleaned


def _ecommerce_find_batch(store, batch_id):
    return next((b for b in store.get('batches', []) if b.get('id') == batch_id), None)


def _ecommerce_find_task(batch, task_id):
    return next((t for t in batch.get('tasks', []) if t.get('id') == task_id), None)


def _ecommerce_find_garment(batch, garment_id):
    return next((g for g in batch.get('garments', []) if g.get('id') == garment_id), None)


def _ecommerce_generation_mode(batch, garment=None):
    """Return the persisted generation workflow for current and historical batches.

    ``target_only`` means the target/action image is the sole image-edit input.
    ``garment_prompt`` means every selected garment/source image is one
    independent image-edit input using the same shared prompt.  Directory
    batches keep each source image bound to its containing directory.
    It is deliberately not text-to-image.  Older batches did not persist a mode,
    so only an explicitly virtual, reference-free group is inferred as target-only.
    """
    mode = str(
        (batch or {}).get('generation_mode')
        or ((batch or {}).get('settings') or {}).get('generation_mode')
        or ''
    ).strip().lower()
    if mode in {'target_only', 'garment_reference', 'garment_prompt'}:
        return mode
    if garment and garment.get('virtual') and not (garment.get('images') or []):
        return 'target_only'
    return 'garment_reference'


def _ecommerce_actions_for_garment(batch, garment):
    actions = list(((batch or {}).get('template') or {}).get('actions') or [])
    if _ecommerce_generation_mode(batch, garment) == 'garment_prompt':
        garment_id = (garment or {}).get('id')
        return [action for action in actions if action.get('garment_id') == garment_id]
    return actions


def _ecommerce_target_reference(action):
    path = str((action or {}).get('action_image') or '').strip()
    if not path or not os.path.isfile(path):
        return None
    return {
        'path': path,
        'url': _ecommerce_local_image_url(path),
        'name': os.path.basename(path),
        'action_order': int((action or {}).get('order') or 0) + 1,
        'role': 'target',
        'override_url': '',
        'override_path': '',
    }


def _ecommerce_mutate_batch(batch_id, mutator):
    with ecommerce_lock:
        store = _ecommerce_load_store()
        batch = _ecommerce_find_batch(store, batch_id)
        if not batch:
            return None
        result = mutator(batch)
        batch['updated_at'] = datetime.now().isoformat(timespec='seconds')
        _ecommerce_save_store(store)
        return result if result is not None else batch


def _ecommerce_batch_snapshot(batch_id):
    with ecommerce_lock:
        batch = _ecommerce_find_batch(_ecommerce_load_store(), batch_id)
        return json.loads(json.dumps(batch, ensure_ascii=False)) if batch else None


def _ecommerce_find_rerun_batch(store, rerun_batch_id):
    return next((row for row in store.get('rerun_batches', []) if row.get('id') == rerun_batch_id), None)


def _ecommerce_rerun_batch_snapshot(rerun_batch_id):
    with ecommerce_lock:
        row = _ecommerce_find_rerun_batch(_ecommerce_load_store(), rerun_batch_id)
        return json.loads(json.dumps(row, ensure_ascii=False)) if row else None


def _ecommerce_mutate_rerun_batch(rerun_batch_id, mutator):
    with ecommerce_lock:
        store = _ecommerce_load_store()
        row = _ecommerce_find_rerun_batch(store, rerun_batch_id)
        if not row:
            return None
        result = mutator(row)
        row['updated_at'] = datetime.now().isoformat(timespec='seconds')
        _ecommerce_save_store(store)
        return result if result is not None else row


def _ecommerce_refresh_rerun_batch_counts(row):
    items = row.get('items') or []
    counts = {state: 0 for state in ('pending', 'running', 'partial', 'accepted', 'failed')}
    for item in items:
        state = item.get('status') or 'pending'
        requested = max(1, int((item.get('payload') or {}).get('count') or item.get('requested_count') or 1))
        archived_count = len([path for path in item.get('archived_paths') or [] if path])
        item['requested_count'] = requested
        item['success_count'] = archived_count
        item['remaining_count'] = max(0, requested - archived_count)
        # 自检修复旧版的“少返也accepted”记录，防止升级后继续被误当完成。
        if state == 'accepted' and archived_count < requested:
            state = 'partial'
            item['status'] = state
        counts[state if state in counts else 'pending'] += 1
    row['counts'] = counts
    row['completed_count'] = counts['accepted']
    row['total_count'] = len(items)
    if items and counts['accepted'] == len(items):
        row['status'] = 'completed'
        row['finished_at'] = row.get('finished_at') or datetime.now().isoformat(timespec='seconds')
    elif row.get('status') == 'completed':
        row['status'] = 'partial'
        row['finished_at'] = ''
    return counts


def _ecommerce_rerun_batch_summary(row, include_items=False):
    snapshot = json.loads(json.dumps(row, ensure_ascii=False))
    _ecommerce_refresh_rerun_batch_counts(snapshot)
    accepted = [item for item in snapshot.get('items') or [] if item.get('status') == 'accepted']
    garments = []
    seen = set()
    for item in accepted:
        garment_id = item.get('garment_id')
        if garment_id and garment_id not in seen:
            seen.add(garment_id)
            garments.append({'id': garment_id, 'name': item.get('garment_name') or garment_id})
    snapshot['accepted_garments'] = garments
    all_items = snapshot.get('items') or []
    snapshot['accepted_image_count'] = sum(
        len([path for path in item.get('archived_paths') or [] if path]) for item in accepted
    )
    snapshot['returned_image_count'] = sum(
        len([path for path in item.get('archived_paths') or [] if path]) for item in all_items
    )
    snapshot['requested_image_count'] = sum(
        max(1, int(item.get('requested_count') or (item.get('payload') or {}).get('count') or 1))
        for item in all_items
    )
    snapshot['item_statuses'] = [{
        'item_id': item.get('item_id'),
        'garment_name': item.get('garment_name') or item.get('garment_id') or '',
        'action_order': int(item.get('action_order') or 0),
        'action_name': item.get('action_name') or '',
        'status': item.get('status') or 'pending',
        'success_count': len([path for path in item.get('archived_paths') or [] if path]),
        'requested_count': max(1, int(item.get('requested_count') or (item.get('payload') or {}).get('count') or 1)),
        'remaining_count': max(0, int(item.get('remaining_count') or 0)),
        'error': item.get('error') or '',
        'recovery_pending': bool(item.get('recovery_pending')),
    } for item in all_items]
    if not include_items:
        snapshot.pop('items', None)
    return snapshot


def _ecommerce_safe_user_path(path, must_exist=False, directory=False):
    if not path:
        return None, '路径为空'
    real = os.path.realpath(os.path.expanduser(path))
    if not _is_allowed_user_storage_path(real):
        return None, '路径不在允许的存储位置内（允许：用户主目录、/Volumes/盘名、/Users/Shared、/Applications、/Library/Application Support、/tmp）'
    if must_exist and not os.path.exists(real):
        return None, '路径不存在'
    if directory and must_exist and not os.path.isdir(real):
        return None, '路径不是文件夹'
    return real, None


def _ecommerce_macos_storage_helper(operation, *paths):
    """让macOS系统进程代为完成受TCC保护目录的文件操作。

    优先用 `launchctl asuser` 切换到用户 GUI 会话执行 shell 命令，
    这样 bash 的 responsible process 是用户的 launchd 会话，而非 Python daemon，
    能绕过 TCC 对 ~/Downloads、~/Desktop、/Volumes/外置盘 等受保护目录的写入限制。
    退路：用 osascript `do shell script`（在某些 macOS 版本下也能工作）。
    """
    if os.uname().sysname != 'Darwin':
        return False, '仅macOS支持系统兼容写入'

    # 构造 shell 命令（所有路径用 shlex.quote 转义，避免注入）
    def _q(p):
        import shlex
        return shlex.quote(str(p))

    if operation == 'probe':
        target_dir, marker = paths[0], paths[1]
        shell_cmd = f'/bin/mkdir -p {_q(target_dir)} && /usr/bin/touch {_q(marker)} && /bin/rm -f {_q(marker)}'
    elif operation == 'mkdir':
        shell_cmd = f'/bin/mkdir -p {_q(paths[0])}'
    elif operation == 'copy':
        source, target, target_dir = paths[0], paths[1], paths[2]
        shell_cmd = f'/bin/mkdir -p {_q(target_dir)} && /bin/cp -p {_q(source)} {_q(target)}'
    elif operation == 'move':
        source, target, target_dir = paths[0], paths[1], paths[2]
        shell_cmd = f'/bin/mkdir -p {_q(target_dir)} && /bin/mv -f {_q(source)} {_q(target)}'
    elif operation == 'copytree':
        source, target, target_dir = paths[0], paths[1], paths[2]
        shell_cmd = f'/bin/mkdir -p {_q(target_dir)} && /usr/bin/ditto {_q(source)} {_q(target)}'
    elif operation == 'remove':
        shell_cmd = f'/bin/rm -rf {_q(paths[0])}'
    else:
        return False, f'unsupported storage operation: {operation}'

    # 优先方案：launchctl asuser 切换到用户会话
    try:
        uid = os.getuid()
        result = subprocess.run(
            ['launchctl', 'asuser', str(uid), '/bin/bash', '-c', shell_cmd],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode == 0:
            return True, ''
        launchctl_error = (result.stderr or result.stdout or f'exit={result.returncode}').strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        launchctl_error = f'launchctl异常: {exc}'
    except Exception as exc:
        launchctl_error = f'launchctl未知异常: {exc}'

    # 退路方案：osascript do shell script
    script = r'''
on run argv
    do shell script (item 1 of argv)
    return "ok"
end run
'''
    try:
        result = subprocess.run(
            ['osascript', '-e', script, shell_cmd],
            capture_output=True, text=True, timeout=60,
        )
        if result.returncode == 0:
            return True, ''
        osascript_error = (result.stderr or result.stdout or f'exit={result.returncode}').strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        osascript_error = f'osascript异常: {exc}'
    except Exception as exc:
        osascript_error = f'osascript未知异常: {exc}'

    return False, f'launchctl: {launchctl_error}; osascript: {osascript_error}'


def _ecommerce_ensure_directory(path):
    try:
        os.makedirs(path, exist_ok=True)
        return 'direct'
    except OSError as exc:
        if exc.errno not in (errno.EPERM, errno.EACCES):
            raise
        ok, helper_error = _ecommerce_macos_storage_helper('mkdir', path)
        if not ok:
            raise PermissionError(f'{exc}; macOS兼容写入也失败: {helper_error}') from exc
        return 'macos_helper'


def _ecommerce_copy_file(source, target):
    try:
        shutil.copy2(source, target)
        return target
    except OSError as exc:
        if exc.errno not in (errno.EPERM, errno.EACCES):
            raise
        ok, helper_error = _ecommerce_macos_storage_helper('copy', source, target, os.path.dirname(target))
        if not ok:
            raise PermissionError(f'{exc}; macOS兼容复制也失败: {helper_error}') from exc
        return target


def _ecommerce_move_path(source, target):
    try:
        os.replace(source, target)
        return target
    except OSError as exc:
        if exc.errno not in (errno.EPERM, errno.EACCES):
            raise
        ok, helper_error = _ecommerce_macos_storage_helper('move', source, target, os.path.dirname(target))
        if not ok:
            raise PermissionError(f'{exc}; macOS兼容移动也失败: {helper_error}') from exc
        return target


def _ecommerce_copytree(source, target):
    try:
        shutil.copytree(source, target, dirs_exist_ok=True)
        return target
    except OSError as exc:
        if exc.errno not in (errno.EPERM, errno.EACCES):
            raise
        ok, helper_error = _ecommerce_macos_storage_helper('copytree', source, target, os.path.dirname(target))
        if not ok:
            raise PermissionError(f'{exc}; macOS兼容目录复制也失败: {helper_error}') from exc
        return target


def _ecommerce_remove_path(path):
    if not os.path.exists(path):
        return
    try:
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
        return
    except OSError as exc:
        if exc.errno not in (errno.EPERM, errno.EACCES):
            raise
        ok, helper_error = _ecommerce_macos_storage_helper('remove', path)
        if not ok:
            raise PermissionError(f'{exc}; macOS兼容删除也失败: {helper_error}') from exc


def _ecommerce_write_json_file(path, payload):
    os.makedirs(os.path.join(BASE_DIR, '_运行缓存', '_临时记录'), exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='record-', suffix='.json', dir=os.path.join(BASE_DIR, '_运行缓存', '_临时记录'))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        _ecommerce_ensure_directory(os.path.dirname(path))
        _ecommerce_copy_file(temporary, path)
        return path
    finally:
        if os.path.exists(temporary):
            try:
                os.remove(temporary)
            except OSError:
                pass


def _ecommerce_probe_writable_directory(path, allow_macos_helper=True):
    """实际创建并删除临时文件，不能只依赖 os.access（macOS TCC 下会误报可写）。"""
    real = os.path.realpath(os.path.expanduser(str(path or '')))
    external = real.startswith(os.path.realpath('/Volumes') + os.sep)
    probe_path = ''
    try:
        os.makedirs(real, exist_ok=True)
        fd, probe_path = tempfile.mkstemp(prefix='.sample-factory-write-test-', dir=real)
        with os.fdopen(fd, 'w') as handle:
            handle.write('ok')
        os.remove(probe_path)
        return {'writable': True, 'path': real, 'external_volume': external}
    except OSError as exc:
        if probe_path:
            try:
                os.remove(probe_path)
            except OSError:
                pass
        direct_error = str(exc)
        if allow_macos_helper and exc.errno in (errno.EPERM, errno.EACCES):
            marker = os.path.join(real, f'.sample-factory-system-write-test-{uuid.uuid4().hex}')
            helper_ok, helper_error = _ecommerce_macos_storage_helper('probe', real, marker)
            if helper_ok:
                return {
                    'writable': True,
                    'path': real,
                    'external_volume': external,
                    'write_mode': 'macos_helper',
                    'warning': 'Python直写被macOS拦截，已启用系统兼容写入；成品仍会保存到你指定的目录。',
                    'direct_error': direct_error,
                }
        else:
            helper_error = ''
        if exc.errno in (errno.EPERM, errno.EACCES):
            code = 'STORAGE_PERMISSION_DENIED'
            if external:
                hint = 'macOS尚未允许使用这个外置盘目录。请点击软件里的“弹窗授权选择”，在系统窗口中重新选择该目录；不需要去系统设置里查找Python。'
            else:
                hint = 'macOS已拒绝写入该目录，请检查目录权限或在“隐私与安全性”中授权Python。'
        elif exc.errno == errno.EROFS:
            code = 'STORAGE_READ_ONLY'
            hint = '该宗卷当前以只读方式挂载，请检查硬盘格式或挂载状态。'
        elif exc.errno == errno.ENOSPC:
            code = 'STORAGE_NO_SPACE'
            hint = '目标磁盘剩余空间不足。'
        else:
            code = 'STORAGE_WRITE_FAILED'
            hint = '无法在目标目录创建文件，请检查目录是否存在及磁盘状态。'
        return {
            'writable': False,
            'path': real,
            'external_volume': external,
            'code': code,
            'error': direct_error,
            'hint': hint,
            'helper_error': helper_error,
        }


@app.route('/api/ecommerce/check-output-path', methods=['POST'])
def ecommerce_check_output_path():
    body = request.get_json(silent=True) or {}
    real, path_error = _ecommerce_safe_user_path(body.get('path'), must_exist=False)
    if path_error:
        return jsonify({'writable': False, 'code': 'STORAGE_PATH_INVALID', 'error': path_error}), 400
    return jsonify(_ecommerce_probe_writable_directory(real))


@app.route('/api/ecommerce/open-storage-permission-settings', methods=['POST'])
def ecommerce_open_storage_permission_settings():
    """打开macOS隐私设置；权限本身必须由用户亲自授予。"""
    try:
        subprocess.Popen(
            ['open', 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return jsonify({'ok': True})
    except OSError as exc:
        return jsonify({'error': f'无法打开系统权限设置: {exc}'}), 500


def _ecommerce_natural_key(text):
    return [int(p) if p.isdigit() else p.lower() for p in re.split(r'(\d+)', str(text))]


def _ecommerce_safe_name(text, fallback='未命名'):
    value = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', '-', str(text or '').strip())
    value = re.sub(r'\s+', ' ', value).strip(' .-')
    return value[:80] or fallback


def _ecommerce_safe_relative_parts(value, fallback='根目录'):
    """Sanitize a relative source directory without flattening its hierarchy."""
    raw_parts = str(value or '').replace('\\', '/').split('/')
    parts = [_ecommerce_safe_name(part) for part in raw_parts if part not in ('', '.', '..')]
    return parts[:12] or [fallback]


def _ecommerce_run_code_parts(action):
    platform = str(action.get('platform') or '').lower()
    platform_code = {'runninghub': 'RH', 'oaihk': 'HK', 'google': 'GO', 'openai': 'OAI'}.get(platform, re.sub(r'\W+', '', platform.upper())[:4] or 'API')
    raw_model = str(action.get('model_key') or action.get('model_id') or action.get('endpoint') or '').lower()
    if ('n-pro' in raw_model or 'banana' in raw_model and 'pro' in raw_model or 'g3-pro' in raw_model): model_code = 'NBP'
    elif 'g31' in raw_model or 'banana-2' in raw_model or 'banana2' in raw_model: model_code = 'NB2'
    elif ('gpt' in raw_model and ('2' in raw_model or 'image' in raw_model)) or 'rhart-image-g-2' in raw_model: model_code = 'GPT2'
    elif 'seedream' in raw_model: model_code = 'SD' + (re.search(r'(\d)', raw_model).group(1) if re.search(r'(\d)', raw_model) else '')
    elif 'flux' in raw_model: model_code = 'FLX' + (re.search(r'(\d)', raw_model).group(1) if re.search(r'(\d)', raw_model) else '')
    elif 'wan' in raw_model: model_code = 'WAN' + ''.join(re.findall(r'\d+', raw_model)[:2])
    else: model_code = (re.sub(r'[^A-Z0-9]+', '', raw_model.upper())[:10] or 'MODEL')
    channel = str(action.get('channel') or '').lower()
    channel_code = 'LC' if channel in ('low-cost', 'cheap', 'channel') else 'OFF' if channel in ('official', 'flagship') else 'STD'
    resolution = str(action.get('resolution') or ('4k' if '4k' in raw_model else '2k')).upper()
    return platform_code, model_code, channel_code, resolution


def _ecommerce_next_run_code(action, batches):
    platform, model, channel, resolution = _ecommerce_run_code_parts(action)
    prefix = f'{platform}-{model}-{channel}-{resolution}'
    used = []
    for batch in batches:
        code = str(batch.get('run_code') or '')
        match = re.fullmatch(re.escape(prefix) + r'-R(\d+)', code)
        if match: used.append(int(match.group(1)))
    return f'{prefix}-R{max(used, default=0) + 1:02d}'


def _ecommerce_write_run_manifest(batch, garment, result_dir):
    actions = _ecommerce_actions_for_garment(batch, garment)
    manifest = {
        'schema': 1, 'run_id': batch.get('id'), 'run_code': batch.get('run_code'),
        'batch_name': batch.get('name'), 'garment_id': garment.get('id'), 'garment_name': garment.get('name'),
        'generation_mode': _ecommerce_generation_mode(batch, garment),
        'created_at': batch.get('created_at'), 'expected_outputs': len(actions),
        'models': [_ecommerce_action_model_signature(action) for action in actions],
        'prompt_hashes': [hashlib.sha256(str(action.get('prompt') or '').encode('utf-8')).hexdigest()[:12] for action in actions],
        'action_ids': [action.get('id') for action in actions],
    }
    _ecommerce_ensure_directory(result_dir)
    manifest_path = os.path.join(result_dir, 'run-manifest.json')
    return _ecommerce_write_json_file(manifest_path, manifest)


def _ecommerce_numbered_images(folder):
    found = {}
    try:
        names = sorted(os.listdir(folder), key=_ecommerce_natural_key)
    except OSError:
        return found
    for name in names:
        path = os.path.join(folder, name)
        if not os.path.isfile(path) or os.path.splitext(name)[1].lower() not in ECOMMERCE_IMAGE_EXTS:
            continue
        match = re.match(r'^\s*0*([1-9]|10)(?:\D|$)', name)
        if match and match.group(1) not in found:
            found[match.group(1)] = os.path.realpath(path)
    return found


def _ecommerce_ordered_six_images(folder, keyword='', max_images=6):
    keyword = str(keyword or '').strip().casefold()
    # 01～10 / 1～10 永远是最高优先级；关键词只是补充识别，不能让合法编号图失效。
    numbered = _ecommerce_numbered_images(folder)
    if len(numbered) == max_images and set(numbered) == {str(index) for index in range(1, max_images + 1)}:
        return numbered
    try:
        all_images = [
            os.path.realpath(os.path.join(folder, name))
            for name in sorted(os.listdir(folder), key=_ecommerce_natural_key)
            if os.path.isfile(os.path.join(folder, name))
            and os.path.splitext(name)[1].lower() in ECOMMERCE_IMAGE_EXTS
            # 兼容 AI-01 与 RH-NB2-LC-4K-R02-AI-01：模型测试结果绝不能
            # 被下一批误当成服装实拍参考图。
            and not re.search(r'(?:^|-)AI-\d+', os.path.splitext(name)[0], re.IGNORECASE)
        ]
    except OSError:
        return numbered
    # 单套文件夹允许1～10张；自然顺序就是提交顺序。
    # 已排除 AI- 前缀的生成图，防止批量跑完后误把生成图当参考图重新跑一遍。
    if 1 <= len(all_images) <= max_images:
        return {str(index + 1): path for index, path in enumerate(all_images)}
    if keyword:
        matched = [path for path in all_images if keyword in os.path.splitext(os.path.basename(path))[0].casefold()]
        if 1 <= len(matched) <= max_images:
            return {str(index + 1): path for index, path in enumerate(matched)}
    return numbered


def _ecommerce_scan_clothing_root(root, keyword='', max_images=6, require_complete=True):
    real_root, err = _ecommerce_safe_user_path(root, must_exist=True, directory=True)
    if err:
        raise ValueError(err)
    garments = []
    invalid = []

    direct = _ecommerce_ordered_six_images(real_root, keyword, max_images=max_images)
    try:
        has_child_directories = any(
            os.path.isdir(os.path.join(real_root, name)) and not name.startswith('.')
            for name in os.listdir(real_root)
        )
    except OSError:
        has_child_directories = False
    # 用户直接选择的单套文件夹可以是1～10张；递归批量要求每个子文件夹有1～10张，防止误分组。
    candidates = [(os.path.basename(real_root.rstrip(os.sep)) or '服装1', real_root, direct)] if not has_child_directories and 1 <= len(direct) <= max_images else []
    if not candidates:
        # 联机拍摄素材经常是“根目录/批量/款号/6张图”。递归最多3层，既支持这种
        # 分组目录，又避免误扫整块硬盘。找到完整服装目录后不再进入它的子目录。
        root_depth = real_root.rstrip(os.sep).count(os.sep)
        skip_names = {'_运行缓存', '_生成样本备份', 'AI换装结果', '__MACOSX'}
        for current, dirs, _files in os.walk(real_root, topdown=True):
            depth = current.rstrip(os.sep).count(os.sep) - root_depth
            dirs[:] = sorted(
                [d for d in dirs if not d.startswith('.') and d not in skip_names and not d.startswith('AI换装结果-')],
                key=_ecommerce_natural_key,
            )
            if depth == 0:
                continue
            if depth > 3:
                dirs[:] = []
                continue
            images = _ecommerce_ordered_six_images(current, keyword, max_images=max_images)
            if (1 <= len(images) <= max_images) and (not require_complete or len(images) == max_images):
                relative_name = os.path.relpath(current, real_root)
                candidates.append((relative_name, os.path.realpath(current), images))
                dirs[:] = []
            elif images:
                invalid.append({'name': os.path.relpath(current, real_root), 'path': current, 'found': sorted(int(k) for k in images)})

    for index, (name, path, images) in enumerate(candidates[:500]):
        garments.append({
            'id': gen_id('garment'),
            'name': name,
            'path': path,
            'images': [images[key] for key in sorted(images, key=lambda value: int(value))],
            'profile': None,
            'profile_error': '',
            'order': index,
        })
    return real_root, garments, invalid


def _ecommerce_scan_prompt_image_root(root, max_images=10000):
    """Recursively group every source image by its containing directory.

    Unlike the six-view garment scanner this mode intentionally accepts any
    number of images per directory. Generated AI files and application cache
    directories are excluded so a rerun cannot ingest its own outputs.
    """
    real_root, err = _ecommerce_safe_user_path(root, must_exist=True, directory=True)
    if err:
        raise ValueError(err)
    skip_names = {
        '_运行缓存', '_生成样本备份', '_废片预览备份', '_重做历史',
        '_重做临时参考图', '_质检缓存', '_成品输出', '__MACOSX',
    }
    groups = []
    total = 0
    for current, dirs, files in os.walk(real_root, topdown=True):
        dirs[:] = sorted([
            name for name in dirs
            if not name.startswith('.')
            and name not in skip_names
            and not name.startswith('AI换装结果-')
        ], key=_ecommerce_natural_key)
        images = []
        for name in sorted(files, key=_ecommerce_natural_key):
            path = os.path.join(current, name)
            stem, ext = os.path.splitext(name)
            if ext.lower() not in ECOMMERCE_IMAGE_EXTS or not os.path.isfile(path):
                continue
            if re.search(r'(?:^|-)AI-\d+', stem, re.IGNORECASE) or stem.endswith('.deleted'):
                continue
            images.append(os.path.realpath(path))
        if not images:
            continue
        total += len(images)
        if total > max_images:
            raise ValueError(f'选中目录共超过{max_images}张图片，为避免误提交高额费用，请分批选择文件夹')
        relative = os.path.relpath(current, real_root)
        display_name = os.path.basename(real_root.rstrip(os.sep)) or '根目录' if relative == '.' else relative
        # The destination mirrors the whole selected tree, including its root
        # folder name, so direct-root files and nested files cannot be flattened
        # into unrelated result directories.
        root_name = os.path.basename(real_root.rstrip(os.sep)) or '根目录'
        preserved_relative = root_name if relative == '.' else os.path.join(root_name, relative)
        groups.append({
            'id': gen_id('garment'),
            'name': display_name,
            'relative_path': preserved_relative,
            'path': os.path.realpath(current),
            'images': images,
            'profile': None,
            'profile_error': '',
            'order': len(groups),
            'prompt_image_group': True,
        })
    if not groups:
        raise ValueError('所选文件夹及子文件夹中没有找到JPG、PNG或WEBP图片')
    return real_root, groups, [], total


def _ecommerce_summarize_batch(batch, include_tasks=False):
    tasks = batch.get('tasks', [])
    counts = {}
    for task in tasks:
        state = task.get('state', 'pending')
        counts[state] = counts.get(state, 0) + 1
    payload = {k: v for k, v in batch.items() if k not in ('tasks', 'reference_cache')}
    payload['task_counts'] = counts
    payload['task_total'] = len(tasks)
    payload['done_total'] = sum(counts.get(s, 0) for s in ECOMMERCE_FINAL_TASK_STATES)
    if include_tasks:
        payload['tasks'] = tasks
    return payload


def _ecommerce_reconcile_batch_status(batch):
    """修正“任务已100%归档、批次仍显示运行中”的短暂或遗留状态。"""
    tasks = batch.get('tasks') or []
    # 修复旧版本“抽卡少返仍标记 accepted”的历史数据：任务只有在
    # 实际归档数达到批次抽卡数时才算完成，否则恢复为 partial，进度不会虚报100%。
    expected = max(1, min(int((batch.get('settings') or {}).get('samples_per_action') or 1), 5))
    repaired_partial = False
    if expected > 1 and not (batch.get('settings') or {}).get('qc_enabled', False):
        for task in tasks:
            if task.get('state') != 'accepted':
                continue
            archived_count = sum(1 for attempt in task.get('attempts') or [] if attempt.get('archived_path'))
            if archived_count < expected:
                task['state'] = 'partial'
                task['last_error'] = f'抽卡部分回填：已完成{archived_count}/{expected}张，还缺{expected - archived_count}张'
                repaired_partial = True
        if repaired_partial and batch.get('status') == 'completed':
            batch['status'] = 'interrupted'
            batch['finished_at'] = ''
    if (
        tasks
        and batch.get('status') in ('running', 'resuming')
        and all(task.get('state') in ECOMMERCE_FINAL_TASK_STATES for task in tasks)
    ):
        batch['status'] = 'completed'
        batch['finished_at'] = batch.get('finished_at') or datetime.now().isoformat(timespec='seconds')
        batch['updated_at'] = datetime.now().isoformat(timespec='seconds')
        return True
    return repaired_partial


def _ecommerce_list_batch_summary(batch):
    """列表页只返回状态索引，避免历史批次把服装路径和图片清单反复传到浏览器。"""
    summary = _ecommerce_summarize_batch(batch, include_tasks=False)
    keys = (
        'id', 'name', 'status', 'created_at', 'updated_at', 'run_code',
        'task_counts', 'task_total', 'done_total', 'usage', 'settings',
    )
    compact = {key: summary.get(key) for key in keys if key in summary}
    compact['garment_total'] = len(batch.get('garments') or [])
    return compact


def _ecommerce_clean_target_actions(actions):
    if not isinstance(actions, list) or not (1 <= len(actions) <= 20):
        raise ValueError('目标替换参考图必须包含1～20张有效图片')
    cleaned = []
    for idx, action in enumerate(actions):
        image_url = str(action.get('action_image') or '').strip()
        prompt = str(action.get('prompt') or '').strip()
        if not image_url or not prompt:
            continue
        cleaned.append({
            'id': gen_id('action'),
            'order': len(cleaned),
            'name': str(action.get('name') or f'目标图{idx + 1}').strip(),
            'action_image': image_url,
            'prompt': prompt,
            'platform': str(action.get('platform') or 'oaihk'),
            'model_key': str(action.get('model_key') or ''),
            'model_id': str(action.get('model_id') or ''),
            'endpoint': str(action.get('endpoint') or ''),
            'poll_endpoint': str(action.get('poll_endpoint') or ''),
            'is_gpt_image': bool(action.get('is_gpt_image')),
            'aspect_ratio': str(action.get('aspect_ratio') or 'auto'),
            'resolution': str(action.get('resolution') or ''),
            'channel': str(action.get('channel') or ''),
            'resolution_guaranteed': bool(action.get('resolution_guaranteed', True)),
            'max_images': max(1, min(int(action.get('max_images') or 10), 20)),
            'price': str(action.get('price') or ''),
            'size': str(action.get('size') or ''),
            'quality': str(action.get('quality') or 'medium'),
            'short_edge': int(action.get('short_edge') or 1536),
            'garment_reference_index': max(-1, min(int(action.get('garment_reference_index') if action.get('garment_reference_index') is not None else -1), 9)),
        })
    if not cleaned:
        raise ValueError('没有找到同时包含目标替换参考图和提示词的有效项目')
    return cleaned


def _ecommerce_snapshot_action_references(actions, output_path, batch_id):
    """Freeze target/action inputs inside one batch so later runs cannot cross-wire them.

    Generated results and rerun backups are never valid action sources for another
    batch merely because their filenames contain the same AI order.  Every new
    garment-reference batch therefore owns byte-for-byte copies plus source hashes.
    """
    snapshot_root = os.path.join(
        os.path.realpath(os.path.expanduser(output_path)), '_批次动作参考图',
        _ecommerce_safe_name(batch_id, '批次'),
    )
    os.makedirs(snapshot_root, exist_ok=True)
    frozen = []
    forbidden_source_parts = {
        '_生成样本备份', '_废片预览备份', '_重做历史', '_质检缓存',
        '.样片工厂废片回收站',
    }
    for index, action in enumerate(actions or []):
        source = _ecommerce_resolve_image_source((action or {}).get('action_image'))
        if forbidden_source_parts.intersection(Path(source).parts):
            raise ValueError(
                f'动作参考图不能来自生成结果或历史缓存目录：{source}。'
                '请重新选择专用的“动作替换参考图”文件夹。'
            )
        digest = hashlib.sha256()
        with open(source, 'rb') as source_file:
            for chunk in iter(lambda: source_file.read(1024 * 1024), b''):
                digest.update(chunk)
        ext = os.path.splitext(source)[1].lower()
        if ext not in ECOMMERCE_IMAGE_EXTS:
            ext = '.jpg'
        source_stem = _ecommerce_safe_name(
            os.path.splitext(os.path.basename(source))[0], f'动作{index + 1:02d}'
        )
        target = os.path.join(snapshot_root, f'动作{index + 1:02d}-{source_stem}{ext}')
        temp_target = f'{target}.tmp-{gen_id("copy")}'
        try:
            shutil.copy2(source, temp_target)
            os.replace(temp_target, target)
        finally:
            if os.path.exists(temp_target):
                os.unlink(temp_target)
        frozen_action = dict(action)
        frozen_action.update({
            'action_image': target,
            'action_source_path': source,
            'action_source_name': os.path.basename(source),
            'action_source_sha256': digest.hexdigest(),
            'action_snapshot_batch_id': batch_id,
        })
        frozen.append(frozen_action)
    return frozen


def _ecommerce_clean_prompt_action(action):
    """Validate the shared prompt/model used for per-source-image generation."""
    if not isinstance(action, dict):
        raise ValueError('请先填写提示词并选择生图模型')
    prompt = str(action.get('prompt') or '').strip()
    if not prompt:
        raise ValueError('提示词不能为空')
    cleaned = _ecommerce_clean_target_actions([{
        **action,
        'action_image': action.get('action_image') or '/tmp/prompt-image-placeholder.jpg',
        'prompt': prompt,
    }])[0]
    cleaned.pop('id', None)
    cleaned.pop('order', None)
    cleaned.pop('name', None)
    cleaned.pop('action_image', None)
    return cleaned


@app.route('/api/ecommerce/templates', methods=['GET', 'POST'])
def ecommerce_templates():
    with ecommerce_lock:
        store = _ecommerce_load_store()
        if request.method == 'GET':
            return jsonify({'templates': store['templates']})

        body = request.get_json(silent=True) or {}
        name = str(body.get('name') or '').strip() or f"目标替换参考图 {datetime.now().strftime('%m-%d %H:%M')}"
        try:
            cleaned = _ecommerce_clean_target_actions(body.get('actions') or [])
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400
        template = {
            'id': gen_id('ectpl'),
            'name': name,
            'actions': cleaned,
            'created_at': datetime.now().isoformat(timespec='seconds'),
            'updated_at': datetime.now().isoformat(timespec='seconds'),
        }
        store['templates'].append(template)
        _ecommerce_save_store(store)
        return jsonify({'ok': True, 'template': template}), 201


@app.route('/api/ecommerce/templates/<template_id>', methods=['DELETE'])
def ecommerce_delete_template(template_id):
    with ecommerce_lock:
        store = _ecommerce_load_store()
        before = len(store['templates'])
        store['templates'] = [t for t in store['templates'] if t.get('id') != template_id]
        if len(store['templates']) == before:
            return jsonify({'error': '模板不存在'}), 404
        _ecommerce_save_store(store)
    return jsonify({'ok': True})


@app.route('/api/ecommerce/scan-clothing-root', methods=['POST'])
def ecommerce_scan_clothing_root():
    body = request.get_json(silent=True) or {}
    try:
        keyword = str(body.get('keyword') or '').strip()
        mode = str(body.get('generation_mode') or '').strip().lower()
        if mode == 'garment_prompt':
            root, garments, invalid, image_total = _ecommerce_scan_prompt_image_root(body.get('path', ''))
        else:
            root, garments, invalid = _ecommerce_scan_clothing_root(
                body.get('path', ''), keyword,
                max_images=10 if bool(body.get('precision_matching')) else 6,
                require_complete=not bool(body.get('precision_matching')),
            )
            image_total = sum(len(garment.get('images') or []) for garment in garments)
        return jsonify({
            'ok': True,
            'path': root,
            'garments': garments,
            'invalid': invalid,
            'garment_count': len(garments),
            'image_total': image_total,
            'generation_mode': mode or 'garment_reference',
            'keyword': keyword,
        })
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400


@app.route('/api/ecommerce/scan-action-root', methods=['POST'])
def ecommerce_scan_action_root():
    body = request.get_json(silent=True) or {}
    real, err = _ecommerce_safe_user_path(body.get('path', ''), must_exist=True, directory=True)
    if err:
        return jsonify({'error': err}), 400
    images = []
    for name in sorted(os.listdir(real), key=_ecommerce_natural_key):
        path = os.path.join(real, name)
        if os.path.isfile(path) and os.path.splitext(name)[1].lower() in ECOMMERCE_IMAGE_EXTS:
            images.append({'name': os.path.splitext(name)[0], 'path': path})
    if not images:
        return jsonify({'error': '目标图片文件夹中没有找到图片'}), 400
    return jsonify({
        'ok': True,
        'path': real,
        'actions': images[:20],
        'action_count': min(len(images), 20),
        'total_found': len(images),
        'truncated': len(images) > 20,
    })


@app.route('/api/ecommerce/batches', methods=['GET', 'POST'])
def ecommerce_batches():
    if request.method == 'GET':
        with ecommerce_lock:
            store = _ecommerce_load_store()
            reconciled = False
            for batch in store['batches']:
                reconciled = _ecommerce_reconcile_batch_status(batch) or reconciled
            if reconciled:
                _ecommerce_save_store(store)
            batches = [_ecommerce_list_batch_summary(b) for b in reversed(store['batches'])]
        return jsonify({'batches': batches})

    body = request.get_json(silent=True) or {}
    requested_mode = str(body.get('generation_mode') or '').strip().lower()
    generation_mode = 'garment_prompt' if requested_mode == 'garment_prompt' else 'garment_reference'
    inline_actions = body.get('actions')
    prompt_action = None
    if generation_mode == 'garment_prompt':
        try:
            prompt_action = _ecommerce_clean_prompt_action(body.get('prompt_action') or {})
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400
        template = {
            'id': gen_id('ectplrun'),
            'name': str(body.get('template_name') or '服装原图批量提示词').strip(),
            'actions': [],
            'created_at': datetime.now().isoformat(timespec='seconds'),
            'updated_at': datetime.now().isoformat(timespec='seconds'),
            'inline_snapshot': True,
        }
    elif inline_actions is not None:
        try:
            cleaned_actions = _ecommerce_clean_target_actions(inline_actions)
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400
        template = {
            'id': gen_id('ectplrun'),
            'name': str(body.get('template_name') or '本次运行目标图').strip(),
            'actions': cleaned_actions,
            'created_at': datetime.now().isoformat(timespec='seconds'),
            'updated_at': datetime.now().isoformat(timespec='seconds'),
            'inline_snapshot': True,
        }
    else:
        template_id = str(body.get('template_id') or '')
        with ecommerce_lock:
            store = _ecommerce_load_store()
            template = next((t for t in store['templates'] if t.get('id') == template_id), None)
        if not template:
            return jsonify({'error': '请加载有效的目标替换参考图'}), 400
    garment_keyword = str(body.get('garment_keyword') or '').strip()
    inline_images = body.get('garment_images') or []
    inline_sources = body.get('garment_sources') or []
    clothing_root = str(body.get('clothing_root') or '').strip()
    if generation_mode == 'garment_prompt' and inline_sources:
        if not isinstance(inline_sources, list) or not (1 <= len(inline_sources) <= 10000):
            return jsonify({'error': '拖入的文件夹最多处理10000张图片，请分批运行'}), 400
        grouped_sources = {}
        ordered_group_keys = []
        try:
            for item in inline_sources:
                if not isinstance(item, dict):
                    raise ValueError('拖入图片的目录信息无效')
                source = _ecommerce_resolve_image_source(item.get('source') or item.get('url'))
                original_name = str(item.get('name') or os.path.basename(source)).strip() or os.path.basename(source)
                relative_value = str(item.get('relative_path') or original_name).replace('\\', '/')
                relative_parts = _ecommerce_safe_relative_parts(relative_value, fallback=original_name)
                parent_parts = relative_parts[:-1]
                if parent_parts:
                    group_key = '/'.join(parent_parts)
                else:
                    group_key = _ecommerce_safe_name(body.get('garment_name') or '所选图片')
                if group_key not in grouped_sources:
                    grouped_sources[group_key] = []
                    ordered_group_keys.append(group_key)
                grouped_sources[group_key].append({
                    'path': source,
                    'name': original_name,
                    'relative_path': '/'.join(relative_parts),
                })
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400
        root = os.path.dirname(grouped_sources[ordered_group_keys[0]][0]['path'])
        garments = []
        for group_key in ordered_group_keys:
            items = grouped_sources[group_key]
            garments.append({
                'id': gen_id('garment'),
                'name': group_key,
                'path': os.path.dirname(items[0]['path']),
                'images': [item['path'] for item in items],
                'source_names': [item['name'] for item in items],
                'source_relative_files': [item['relative_path'] for item in items],
                'profile': None,
                'profile_error': '',
                'order': len(garments),
                'relative_path': group_key,
                'prompt_image_group': True,
                'uploaded_directory_group': bool('/' in group_key),
            })
        invalid = []
    elif inline_images:
        inline_limit = 10000 if generation_mode == 'garment_prompt' else 10
        if not isinstance(inline_images, list) or not (1 <= len(inline_images) <= inline_limit):
            message = f'直接选择图片最多{inline_limit}张' if generation_mode == 'garment_prompt' else '单套服装参考图必须是1～10张'
            return jsonify({'error': message}), 400
        try:
            resolved_images = [_ecommerce_resolve_image_source(source) for source in inline_images]
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400
        root = os.path.dirname(resolved_images[0])
        garments = [{
            'id': gen_id('garment'),
            'name': _ecommerce_safe_name(body.get('garment_name') or '单套测试'),
            'path': root,
            'images': resolved_images,
            'profile': None,
            'profile_error': '',
            'order': 0,
            'relative_path': _ecommerce_safe_name(body.get('garment_name') or '所选图片'),
            'prompt_image_group': generation_mode == 'garment_prompt',
        }]
        invalid = []
    elif clothing_root:
        try:
            if generation_mode == 'garment_prompt':
                root, garments, invalid, _image_total = _ecommerce_scan_prompt_image_root(clothing_root)
            else:
                root, garments, invalid = _ecommerce_scan_clothing_root(
                    clothing_root, garment_keyword,
                    max_images=10 if bool(body.get('precision_matching')) else 6,
                    require_complete=not bool(body.get('precision_matching')),
                )
        except ValueError as exc:
            return jsonify({'error': str(exc)}), 400
        if not garments:
            return jsonify({'error': '没有找到有效服装参考图；单套或批量子文件夹需1～10张'}), 400
    else:
        return jsonify({'error': '请选择服装图片，或选择包含服装图的文件夹'}), 400
    garment_limit = max(0, min(int(body.get('garment_limit') or 0), 500))
    if garment_limit:
        garments = garments[:garment_limit]
    action_limit = max(0, min(int(body.get('action_limit') or 0), 20))
    if generation_mode == 'garment_prompt':
        actions_for_batch = []
        for garment in garments:
            source_names = list(garment.get('source_names') or [])
            source_relative_files = list(garment.get('source_relative_files') or [])
            for local_order, source_path in enumerate(garment.get('images') or []):
                source_name = source_names[local_order] if local_order < len(source_names) else os.path.basename(source_path)
                action = {
                    **prompt_action,
                    'id': gen_id('action'),
                    'order': local_order,
                    'global_order': len(actions_for_batch),
                    'garment_id': garment['id'],
                    'name': os.path.splitext(source_name)[0] or f'图片{local_order + 1}',
                    'action_image': source_path,
                    'source_name': source_name,
                    'source_relative_path': source_relative_files[local_order] if local_order < len(source_relative_files) else '',
                }
                actions_for_batch.append(action)
        template['actions'] = actions_for_batch
    else:
        actions_for_batch = (template.get('actions') or [])[:action_limit or None]

    output_path = body.get('output_path') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '_运行缓存')
    output_path, err = _ecommerce_safe_user_path(output_path, must_exist=False)
    if err:
        return jsonify({'error': err}), 400
    # 运行缓存包含高频写入和图像编码，必须由 Python 直接写入；若外置盘只允许
    # 系统兼容写入，则缓存回退本地，最终成品仍可写到用户选择的外置盘。
    cache_probe = _ecommerce_probe_writable_directory(output_path, allow_macos_helper=False)
    cache_fallback_reason = ''
    if not cache_probe.get('writable'):
        # 用户选的目录没权限，fallback 到应用自己的目录
        cache_fallback_reason = cache_probe.get('error') or cache_probe.get('hint') or '目录不可写'
        logger.warning(f'[ecommerce] 用户指定的缓存目录不可写 ({output_path}): {cache_fallback_reason}，fallback 到应用目录')
        output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_运行缓存')
        fallback_cache_probe = _ecommerce_probe_writable_directory(output_path, allow_macos_helper=False)
        if not fallback_cache_probe.get('writable'):
            return jsonify({'error': f"缓存目录与本地回退目录都不可写: {fallback_cache_probe.get('error') or fallback_cache_probe.get('hint')}"}), 500

    batch_id = gen_id('ecbatch')
    batch_name = str(body.get('name') or f"电商批次 {datetime.now().strftime('%m-%d %H:%M')}").strip()
    requested_final_output_path = body.get('final_output_path') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '_成品输出')
    final_output_path = requested_final_output_path
    final_output_path, final_err = _ecommerce_safe_user_path(final_output_path, must_exist=False)
    if final_err:
        return jsonify({'error': f'成品目录无效: {final_err}'}), 400
    requested_final_output_path = final_output_path
    final_probe = _ecommerce_probe_writable_directory(final_output_path)
    final_output_fallback = False
    final_output_fallback_reason = ''
    if not final_probe.get('writable'):
        final_output_fallback_reason = final_probe.get('error') or final_probe.get('hint') or '目录不可写'
        if not bool(body.get('allow_final_fallback')):
            return jsonify({
                'error': f"成品目录不可写：{final_probe.get('hint') or final_output_fallback_reason}",
                'code': final_probe.get('code') or 'FINAL_OUTPUT_UNWRITABLE',
                'path': final_output_path,
                'external_volume': bool(final_probe.get('external_volume')),
                'permission_hint': final_probe.get('hint') or '',
                'can_use_local_fallback': True,
            }), 409
        fallback_final = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_成品输出')
        fallback_final_probe = _ecommerce_probe_writable_directory(fallback_final)
        if not fallback_final_probe.get('writable'):
            return jsonify({'error': f"成品目录与本地回退目录都不可写: {fallback_final_probe.get('error') or fallback_final_probe.get('hint')}"}), 500
        logger.warning('[ecommerce] 成品目录不可写 (%s): %s，用户已确认回退到 %s', final_output_path, final_output_fallback_reason, fallback_final)
        final_output_path = fallback_final
        final_output_fallback = True
    if generation_mode != 'garment_prompt':
        try:
            actions_for_batch = _ecommerce_snapshot_action_references(
                actions_for_batch, output_path, batch_id
            )
        except (OSError, ValueError) as exc:
            return jsonify({'error': f'冻结动作参考图失败：{exc}'}), 400
        # 批次模板只保存自己的不可变快照；源目录后续改名、删图或扫描其他批次，
        # 都不能再悄悄改变这个批次实际递交的动作参考图。
        template = dict(template)
        template['actions'] = actions_for_batch
    with ecommerce_lock:
        existing_batches = list(_ecommerce_load_store().get('batches', []))
    run_code = _ecommerce_next_run_code(actions_for_batch[0] if actions_for_batch else {}, existing_batches)
    result_dirs = {}
    for garment in garments:
        if generation_mode == 'garment_prompt':
            relative_parts = _ecommerce_safe_relative_parts(garment.get('relative_path') or garment.get('name'))
            result_dirs[garment['id']] = os.path.join(final_output_path, *relative_parts, run_code)
        else:
            result_dirs[garment['id']] = os.path.join(final_output_path, _ecommerce_safe_name(garment['name']), run_code)
    tasks = []
    for garment in garments:
        for action in actions_for_batch:
            if generation_mode == 'garment_prompt' and action.get('garment_id') != garment.get('id'):
                continue
            tasks.append({
                'id': gen_id('ectask'),
                'order': len(tasks),
                'garment_id': garment['id'],
                'garment_name': garment['name'],
                'action_id': action['id'],
                'action_order': action['order'],
                'action_name': action['name'],
                'state': 'pending',
                'attempts': [],
                'accepted_path': '',
                'manual_review_path': '',
                'last_error': '',
                'created_at': datetime.now().isoformat(timespec='seconds'),
                'updated_at': datetime.now().isoformat(timespec='seconds'),
            })
    batch = {
        'id': batch_id,
        'name': batch_name,
        'status': 'draft',
        'template_id': template['id'],
        'template_name': template['name'],
        'template': template,
        'generation_mode': generation_mode,
        'clothing_root': root,
        'output_path': output_path,
        'action_snapshot_root': (
            os.path.dirname(actions_for_batch[0]['action_image'])
            if generation_mode != 'garment_prompt' and actions_for_batch else ''
        ),
        'final_output_path': final_output_path,
        'run_code': run_code,
        'result_dirs': result_dirs,
        'result_folder_name': f"AI换装结果-{_ecommerce_safe_name(batch_name)}",
        'garments': garments,
        'invalid_folders': invalid,
        'tasks': tasks,
        'reference_cache': {},
        'usage': {'generation_requests': 0, 'profile_calls': 0, 'qc_calls': 0, 'qc_repair_calls': 0},
        'settings': {
            'max_attempts': max(1, min(int(body.get('max_attempts') or 3), 3)),
            'concurrency': max(1, min(int(body.get('concurrency') or 10), ECOMMERCE_MAX_CONCURRENCY)),
            'schedule_mode': 'garment_round_qc',
            'garment_limit': garment_limit,
            'action_limit': action_limit,
            # 递归服装原图模式是逐图提示词编辑，不复用六视图服装质检。
            'qc_enabled': bool(body.get('qc_enabled', True)) if generation_mode == 'garment_reference' else False,
            'qc_model': str(body.get('qc_model') or 'gemini-2.5-pro').strip(),
            'profile_mode': str(body.get('profile_mode') or 'visual_sheets').strip() if str(body.get('profile_mode') or 'visual_sheets').strip() in {'visual_sheets', 'ai_text'} else 'visual_sheets',
            'qc_threshold': max(50, min(int(body.get('qc_threshold') or 85), 100)),
            'samples_per_action': max(1, min(int(body.get('samples_per_action') or 1), 5)),
            'garment_keyword': garment_keyword,
            'generation_mode': generation_mode,
            'precision_matching': bool(body.get('precision_matching')) if generation_mode == 'garment_reference' else False,
            'requested_final_output_path': requested_final_output_path,
            'final_output_write_mode': final_probe.get('write_mode') or 'direct',
            'final_output_write_warning': final_probe.get('warning') or '',
            'final_output_fallback': final_output_fallback,
            'final_output_fallback_reason': final_output_fallback_reason,
            'cache_output_fallback': bool(cache_fallback_reason),
            'cache_output_fallback_reason': cache_fallback_reason,
        },
        'created_at': datetime.now().isoformat(timespec='seconds'),
        'updated_at': datetime.now().isoformat(timespec='seconds'),
    }
    for garment in garments:
        _ecommerce_write_run_manifest(batch, garment, result_dirs[garment['id']])
    with ecommerce_lock:
        store = _ecommerce_load_store()
        store['batches'].append(batch)
        _ecommerce_save_store(store)
    samples_per_action = int((batch.get('settings') or {}).get('samples_per_action') or 1)
    paid_call_total = len(actions_for_batch) * samples_per_action
    warning = (
        f'已加载{len(actions_for_batch)}张服装原图；每张生成{samples_per_action}个候选，预计{paid_call_total}次付费图生图调用；'
        '输出保留原文件夹层级，AI六视图质检已关闭。'
        if generation_mode == 'garment_prompt' else ''
    )
    if final_output_fallback:
        fallback_warning = f'原成品目录不可写，已按你的确认保存到本地成品目录：{final_output_path}；完整运行缓存仍会保留。'
        warning = f'{warning} {fallback_warning}'.strip()
    return jsonify({'ok': True, 'batch': _ecommerce_summarize_batch(batch, include_tasks=True), 'warning': warning}), 201


@app.route('/api/ecommerce/batches/<batch_id>', methods=['GET'])
def ecommerce_get_batch(batch_id):
    with ecommerce_lock:
        store = _ecommerce_load_store()
        batch = _ecommerce_find_batch(store, batch_id)
        if not batch:
            return jsonify({'error': '批次不存在'}), 404
        if _ecommerce_reconcile_batch_status(batch):
            _ecommerce_save_store(store)
        snapshot = json.loads(json.dumps(batch, ensure_ascii=False))
    return jsonify({'batch': _ecommerce_summarize_batch(snapshot, include_tasks=True)})


@app.route('/api/ecommerce/batches/<batch_id>/rebind-action-references', methods=['POST'])
@_local_only
def ecommerce_rebind_action_references(batch_id):
    """Safely repair one batch whose action references were bound to wrong files.

    This maintenance endpoint deliberately requires the replacement folder to
    contain exactly the same number of actions.  It runs inside ecommerce_lock,
    rejects active reruns, creates a timestamped data backup, and then stores an
    immutable per-batch snapshot so the folder cannot drift again.
    """
    body = request.get_json(silent=True) or {}
    action_root, err = _ecommerce_safe_user_path(
        body.get('action_root') or '', must_exist=True, directory=True
    )
    if err:
        return jsonify({'error': err}), 400
    source_paths = [
        os.path.join(action_root, name)
        for name in sorted(os.listdir(action_root), key=_ecommerce_natural_key)
        if os.path.isfile(os.path.join(action_root, name))
        and os.path.splitext(name)[1].lower() in ECOMMERCE_IMAGE_EXTS
    ]
    if not source_paths:
        return jsonify({'error': '动作参考图文件夹中没有图片'}), 400

    with ecommerce_lock:
        store = _ecommerce_load_store()
        batch = _ecommerce_find_batch(store, batch_id)
        if not batch:
            return jsonify({'error': '批次不存在'}), 404
        if _ecommerce_generation_mode(batch) == 'garment_prompt':
            return jsonify({'error': '服装原图提示词批次不使用动作参考图'}), 409
        active_reruns = [
            row for row in store.get('rerun_batches') or []
            if row.get('batch_id') == batch_id
            and row.get('status') in {'running', 'resuming'}
        ]
        if active_reruns:
            return jsonify({'error': '该批次仍有正在运行的重做任务，不能更换动作参考图'}), 409
        current_actions = list(((batch.get('template') or {}).get('actions') or []))
        if len(source_paths) != len(current_actions):
            return jsonify({
                'error': (
                    f'新目录有{len(source_paths)}张图，但批次固定为{len(current_actions)}个动作；'
                    '数量不一致，已拒绝修改'
                )
            }), 409

        replacements = []
        for index, (current, source) in enumerate(zip(current_actions, source_paths)):
            replacement = dict(current)
            replacement.update({
                'order': index,
                'name': os.path.splitext(os.path.basename(source))[0],
                'action_image': source,
            })
            replacements.append(replacement)
        try:
            frozen = _ecommerce_snapshot_action_references(
                replacements, batch.get('output_path') or BASE_DIR, batch_id
            )
        except (OSError, ValueError) as exc:
            return jsonify({'error': f'冻结动作参考图失败：{exc}'}), 400

        timestamp = datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        data_path = os.path.join(DATA_DIR, ECOMMERCE_DATA_FILE)
        backup_path = os.path.join(
            DATA_DIR, f'ecommerce_batches.before-action-reference-repair-{timestamp}.json'
        )
        if os.path.isfile(data_path):
            shutil.copy2(data_path, backup_path)

        template = dict(batch.get('template') or {})
        template['actions'] = frozen
        template['updated_at'] = datetime.now().isoformat(timespec='seconds')
        batch['template'] = template
        batch['action_snapshot_root'] = os.path.dirname(frozen[0]['action_image'])
        batch['action_reference_source_root'] = action_root
        batch['action_reference_repaired_at'] = datetime.now().isoformat(timespec='seconds')
        names_by_order = {int(action.get('order') or 0): action.get('name') for action in frozen}
        for task in batch.get('tasks') or []:
            order = int(task.get('action_order') or 0)
            if order in names_by_order:
                task['action_name'] = names_by_order[order]
                task['updated_at'] = datetime.now().isoformat(timespec='seconds')
        batch['updated_at'] = datetime.now().isoformat(timespec='seconds')
        _ecommerce_save_store(store)

    return jsonify({
        'ok': True,
        'batch_id': batch_id,
        'action_root': action_root,
        'snapshot_root': os.path.dirname(frozen[0]['action_image']),
        'backup_path': backup_path,
        'actions': [
            {
                'order': int(action.get('order') or 0) + 1,
                'name': action.get('name'),
                'source_path': action.get('action_source_path'),
                'snapshot_path': action.get('action_image'),
                'sha256': action.get('action_source_sha256'),
            }
            for action in frozen
        ],
    })


def _ecommerce_resolve_image_source(source):
    source = str(source or '')
    if source.startswith('/static/'):
        real = os.path.realpath(os.path.join(BASE_DIR, source.lstrip('/')))
        if not real.startswith(os.path.realpath(BASE_DIR) + os.sep):
            raise ValueError('目标替换参考图路径不安全')
    else:
        real, err = _ecommerce_safe_user_path(source, must_exist=True)
        if err:
            raise ValueError(err)
    if not os.path.isfile(real):
        raise ValueError(f'图片不存在: {source}')
    return real


def _ecommerce_image_bytes(source, max_long_edge=3072, quality=92):
    path = _ecommerce_resolve_image_source(source)
    with Image.open(path) as original:
        img = ImageOps.exif_transpose(original)
        if max(img.size) > max_long_edge:
            scale = max_long_edge / max(img.size)
            img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)
        if img.mode != 'RGB':
            img = img.convert('RGB')
        buf = io.BytesIO()
        img.save(buf, 'JPEG', quality=quality, optimize=True)
        return buf.getvalue()


def _ecommerce_image_data_uri(source, max_long_edge=1600, quality=86):
    raw = _ecommerce_image_bytes(source, max_long_edge=max_long_edge, quality=quality)
    return 'data:image/jpeg;base64,' + base64.b64encode(raw).decode('ascii')


def _ecommerce_reference_data_uri(source):
    """Return a compressed local reference as a data URI, with a small RAM cache.

    HK/Fal accepts data URIs in ``image_urls``.  Keeping the upload inside the
    request removes the fragile tmpfiles.org dependency that previously made a
    multi-image task fail before it even reached HK.  The cache is deliberately
    bounded: one active garment wave plus up to 20 action images fits, while a
    100-garment overnight run cannot grow RAM without limit.
    """
    path = _ecommerce_resolve_image_source(source)
    stat = os.stat(path)
    cache_key = hashlib.sha256(path.encode('utf-8')).hexdigest()
    fingerprint = f'{stat.st_mtime_ns}:{stat.st_size}'
    lock = ecommerce_reference_locks.setdefault(f'data:{cache_key}', threading.Lock())
    with lock:
        cached = ecommerce_reference_data_cache.get(cache_key)
        if cached and cached.get('fingerprint') == fingerprint:
            return cached['data_uri']
        raw = _ecommerce_image_bytes(source, max_long_edge=3072, quality=90)
        data_uri = 'data:image/jpeg;base64,' + base64.b64encode(raw).decode('ascii')
        with ecommerce_lock:
            ecommerce_reference_data_cache[cache_key] = {
                'fingerprint': fingerprint,
                'data_uri': data_uri,
            }
            while len(ecommerce_reference_data_cache) > ECOMMERCE_REFERENCE_DATA_CACHE_MAX:
                oldest_key = next(iter(ecommerce_reference_data_cache))
                ecommerce_reference_data_cache.pop(oldest_key, None)
        return data_uri


def _ecommerce_upload_tmpfiles_reference(batch_id, source):
    """Legacy public-URL fallback kept for providers that reject data URIs."""
    cache_key = hashlib.sha256(str(source).encode('utf-8')).hexdigest()
    lock = ecommerce_reference_locks.setdefault(f'tmp:{batch_id}:{cache_key}', threading.Lock())
    with lock:
        batch = _ecommerce_batch_snapshot(batch_id)
        cached = (batch.get('reference_cache') or {}).get(cache_key) if batch else None
        if isinstance(cached, dict):
            age = time.time() - float(cached.get('uploaded_at') or 0)
            if cached.get('url') and age < 2700:  # 临时图床按45分钟主动刷新，适合长时间批跑。
                return cached['url']
        raw = _ecommerce_image_bytes(source)
        last_error = None
        for retry in range(3):
            try:
                resp = requests.post(
                    'https://tmpfiles.org/api/v1/upload',
                    files={'file': (f'ec_{cache_key[:12]}.jpg', raw, 'image/jpeg')},
                    timeout=90,
                )
                if resp.status_code != 200:
                    raise RuntimeError(f'图床HTTP {resp.status_code}')
                url = ((resp.json().get('data') or {}).get('url') or '').replace('tmpfiles.org/', 'tmpfiles.org/dl/')
                if not url:
                    raise RuntimeError('图床没有返回URL')
                entry = {'url': url, 'uploaded_at': time.time()}
                _ecommerce_mutate_batch(batch_id, lambda b: b.setdefault('reference_cache', {}).__setitem__(cache_key, entry))
                return url
            except Exception as exc:
                last_error = exc
                time.sleep(2 ** retry)
        raise RuntimeError(f'参考图上传失败: {last_error}')


def _ecommerce_upload_public_reference(batch_id, source):
    # Function name is retained for compatibility with existing tests/callers.
    # No third-party image host is involved on the normal path.
    return _ecommerce_reference_data_uri(source)


def _ecommerce_upload_runninghub_reference(batch_id, source):
    """Upload one reference to RunningHub's official media endpoint and cache its URL.

    Standard Model API documents require ``imageUrls``.  A data URI may pass an
    early auth check but is not a documented model input, so production batches
    use RunningHub's own one-day ``download_url`` instead.
    """
    path = _ecommerce_resolve_image_source(source)
    config = load_json('model_config.json') or {}
    api_key = str(config.get('rh_api_key') or '').strip()
    base_url = _normalize_runninghub_base_url(config.get('rh_base_url'))
    if not api_key:
        raise RuntimeError('RunningHub API Key 未配置')
    ok, error, _ = _validate_url(base_url + '/', ALLOWED_API_DOMAINS)
    if not ok:
        raise RuntimeError(f'RunningHub 接口地址无效: {error}')
    stat = os.stat(path)
    cache_key = hashlib.sha256(
        f'runninghub:{base_url}:{path}:{stat.st_size}:{stat.st_mtime_ns}'.encode('utf-8')
    ).hexdigest()
    lock = ecommerce_reference_locks.setdefault(f'rh:{batch_id}:{cache_key}', threading.Lock())
    with lock:
        batch = _ecommerce_batch_snapshot(batch_id)
        cached = (batch.get('reference_cache') or {}).get(cache_key) if batch else None
        if isinstance(cached, dict):
            age = time.time() - float(cached.get('uploaded_at') or 0)
            if cached.get('url') and age < 20 * 3600:
                return cached['url']

        raw = _ecommerce_image_bytes(path, max_long_edge=4096, quality=92)
        if len(raw) > 9 * 1024 * 1024:
            raw = _ecommerce_image_bytes(path, max_long_edge=3072, quality=86)
        filename = f'ec_{cache_key[:12]}.jpg'
        last_error = None
        for retry in range(3):
            try:
                with ecommerce_runninghub_upload_semaphore:
                    response = requests.post(
                        f'{base_url}/media/upload/binary',
                        headers={'Authorization': f'Bearer {api_key}'},
                        files={'file': (filename, io.BytesIO(raw), 'image/jpeg')},
                        timeout=90,
                    )
                try:
                    result = response.json()
                except ValueError as exc:
                    raise RuntimeError(f'上传接口返回非JSON（HTTP {response.status_code}）') from exc
                data = result.get('data') if isinstance(result.get('data'), dict) else {}
                url = str(data.get('download_url') or result.get('download_url') or '').strip()
                if response.status_code != 200 or not url:
                    message = result.get('errorMessage') or result.get('message') or result.get('msg') or f'HTTP {response.status_code}'
                    raise RuntimeError(str(message))
                ok, error, _ = _validate_url(url, ALLOWED_IMAGE_DOMAINS)
                if not ok:
                    raise RuntimeError(f'RunningHub上传返回了不允许的地址: {error}')
                entry = {
                    'url': url,
                    'uploaded_at': time.time(),
                    'provider': 'runninghub',
                    'source_size': stat.st_size,
                    'upload_size': len(raw),
                }
                _ecommerce_mutate_batch(
                    batch_id,
                    lambda b: b.setdefault('reference_cache', {}).__setitem__(cache_key, entry),
                )
                return url
            except Exception as exc:
                last_error = exc
                if retry < 2:
                    time.sleep(2 ** retry)
        raise RuntimeError(f'RunningHub参考图上传失败: {last_error}')


def _ecommerce_parse_json_text(text):
    if isinstance(text, dict):
        return text
    cleaned = str(text or '').strip()
    cleaned = re.sub(r'^```(?:json)?\s*|\s*```$', '', cleaned, flags=re.IGNORECASE | re.DOTALL)
    start, end = cleaned.find('{'), cleaned.rfind('}')
    if start >= 0 and end > start:
        cleaned = cleaned[start:end + 1]
    attempts = [cleaned]
    repaired = re.sub(r',\s*([}\]])', r'\1', cleaned)
    # 部分中转视觉模型偶发漏掉字段之间的逗号；只在“完整JSON值 + 下一字段名”边界修补。
    repaired = re.sub(
        r'((?:true|false|null)|[}\]]|"|\d)\s*(?="[^"\n]+"\s*:)',
        r'\1,',
        repaired,
        flags=re.IGNORECASE,
    )
    if repaired != cleaned:
        attempts.append(repaired)
    last_error = None
    for candidate in attempts:
        try:
            parsed = json.loads(candidate, strict=False)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError as exc:
            last_error = exc
    raise last_error or ValueError('视觉模型没有返回JSON对象')


def _ecommerce_vision_json(model, prompt, labeled_sources, timeout=240):
    config = load_json('model_config.json') or {}
    api_key = str(config.get('oaihk_api_key') or '').strip()
    base_url = str(config.get('oaihk_base_url') or 'https://api.openai-hk.com').rstrip('/')
    if not api_key:
        raise RuntimeError('OpenAI-HK API Key 未配置')
    content = [{'type': 'text', 'text': prompt}]
    for label, source in labeled_sources:
        content.append({'type': 'text', 'text': label})
        content.append({'type': 'image_url', 'image_url': {'url': _ecommerce_image_data_uri(source)}})
    payload = {
        'model': model,
        'temperature': 0.1,
        'max_tokens': 2400,
        'response_format': {'type': 'json_object'},
        'messages': [{'role': 'user', 'content': content}],
    }
    resp = _oaihk_request_with_fallback(
        'POST', base_url, 'v1/chat/completions',
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        json=payload, timeout=timeout,
        disable_system_proxy=not _to_bool(config.get('oaihk_use_system_proxy'), False),
    )
    if resp.status_code != 200:
        raise RuntimeError(f'质检模型HTTP {resp.status_code}: {resp.text[:200]}')
    data = resp.json()
    content_text = (((data.get('choices') or [{}])[0].get('message') or {}).get('content') or '')
    try:
        return _ecommerce_parse_json_text(content_text)
    except Exception as parse_error:
        # 低价中转偶尔在长JSON中漏逗号。这里只把已有文字修成合法JSON，不再上传/识别图片。
        repair_payload = {
            'model': model,
            'temperature': 0,
            'max_tokens': 2400,
            'response_format': {'type': 'json_object'},
            'messages': [{
                'role': 'user',
                'content': '下面内容本应是JSON对象，但存在语法错误。只修复JSON语法，保持字段和值的语义不变；只输出合法JSON对象，不要解释。\n' + content_text,
            }],
        }
        repair_resp = _oaihk_request_with_fallback(
            'POST', base_url, 'v1/chat/completions',
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
            json=repair_payload, timeout=timeout,
            disable_system_proxy=not _to_bool(config.get('oaihk_use_system_proxy'), False),
        )
        if repair_resp.status_code != 200:
            raise parse_error
        repaired_text = ((((repair_resp.json().get('choices') or [{}])[0].get('message') or {}).get('content')) or '')
        logger.warning('[ecommerce-qc] 视觉JSON语法损坏，已使用纯文本修复调用恢复')
        repaired = _ecommerce_parse_json_text(repaired_text)
        repaired['_json_repaired'] = True
        return repaired


def _ecommerce_parse_profile_line(text):
    aliases = {
        '视角': 'views_summary', '概括': 'garment_summary', '领口': 'collar',
        '衣襟': 'placket', '扣件': 'fasteners', '拉链': 'zipper',
        '袖口': 'sleeves', '开叉': 'slits', '材质': 'material',
        '花纹': 'pattern', '颜色': 'colors', '关键': 'critical_identity_features',
        '不确定': 'uncertain_features',
    }
    cleaned = str(text or '').replace('\n', '|').replace('｜', '|')
    profile = {}
    for item in cleaned.split('|'):
        if '=' not in item and '：' in item:
            item = item.replace('：', '=', 1)
        if '=' not in item:
            continue
        key, value = item.split('=', 1)
        normalized = re.sub(r'^[\s\d.、*-]+|[\s`]+$', '', key)
        mapped = aliases.get(normalized)
        if mapped and value.strip():
            profile[mapped] = value.strip().strip('`')[:120]
    return profile


def _ecommerce_vision_profile_line(model, prompt, labeled_sources, timeout=240):
    config = load_json('model_config.json') or {}
    api_key = str(config.get('oaihk_api_key') or '').strip()
    base_url = str(config.get('oaihk_base_url') or 'https://api.openai-hk.com').rstrip('/')
    if not api_key:
        raise RuntimeError('OpenAI-HK API Key 未配置')
    content = [{'type': 'text', 'text': prompt}]
    for label, source in labeled_sources:
        content.append({'type': 'text', 'text': label})
        content.append({'type': 'image_url', 'image_url': {'url': _ecommerce_image_data_uri(source)}})
    payload = {
        'model': model,
        'temperature': 0,
        'max_tokens': 600,
        'messages': [{'role': 'user', 'content': content}],
    }
    resp = _oaihk_request_with_fallback(
        'POST', base_url, 'v1/chat/completions',
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        json=payload, timeout=timeout,
        disable_system_proxy=not _to_bool(config.get('oaihk_use_system_proxy'), False),
    )
    if resp.status_code != 200:
        raise RuntimeError(f'服装建档模型HTTP {resp.status_code}: {resp.text[:200]}')
    data = resp.json()
    content_text = (((data.get('choices') or [{}])[0].get('message') or {}).get('content') or '')
    profile = _ecommerce_parse_profile_line(content_text)
    profile['raw_profile_line'] = content_text[:1200]
    return profile


def _ecommerce_increment_usage(batch_id, key):
    def update(batch):
        usage = batch.setdefault('usage', {})
        usage[key] = int(usage.get(key) or 0) + 1
    _ecommerce_mutate_batch(batch_id, update)


def _ecommerce_record_runninghub_usage(batch_id, task_id, attempt, response):
    """把 RunningHub 查询响应中的真实费用写入批次，且断点续查不会重复累计。"""
    provider_usage = response.get('usage') if isinstance(response, dict) else None
    if not isinstance(provider_usage, dict):
        return
    money_value = provider_usage.get('thirdPartyConsumeMoney')
    if money_value in (None, ''):
        money_value = provider_usage.get('consumeMoney')
    try:
        billed_cny = float(money_value) if money_value not in (None, '') else None
    except (TypeError, ValueError):
        billed_cny = None

    def update(batch):
        task = _ecommerce_find_task(batch, task_id)
        if not task:
            return
        attempts = task.setdefault('attempts', [])
        # 重做任务的 number 固定为 99，不能只按 number 去重；否则同一动作的
        # 第2/第3张重做会被误认为第1张，费用既会串批次也会漏记。
        attempt_id = str(attempt.get('id') or '')
        existing = next((item for item in attempts if attempt_id and str(item.get('id') or '') == attempt_id), None)
        if existing is None and not attempt_id:
            existing = next((item for item in attempts if int(item.get('number') or 0) == int(attempt.get('number') or 0)), None)
        if existing is None:
            existing = dict(attempt)
            attempts.append(existing)
        already_recorded = bool(existing.get('billing_recorded'))
        existing['provider_usage'] = provider_usage
        existing['billing_recorded'] = True
        if billed_cny is not None:
            existing['billed_cny'] = round(billed_cny, 6)
            if not already_recorded:
                usage = batch.setdefault('usage', {})
                usage['runninghub_billed_cny'] = round(float(usage.get('runninghub_billed_cny') or 0) + billed_cny, 6)

    _ecommerce_mutate_batch(batch_id, update)
    attempt['provider_usage'] = provider_usage
    attempt['billing_recorded'] = True
    if billed_cny is not None:
        attempt['billed_cny'] = round(billed_cny, 6)


def _ecommerce_place_sheet_image(canvas, source_image, cell, label):
    left, top, right, bottom = cell
    pad = 8
    label_h = 28
    max_w = max(1, right - left - pad * 2)
    max_h = max(1, bottom - top - pad * 2 - label_h)
    image = source_image.copy()
    image.thumbnail((max_w, max_h), Image.LANCZOS)
    x = left + (right - left - image.width) // 2
    y = top + label_h + (bottom - top - label_h - image.height) // 2
    canvas.paste(image, (x, y))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((left, top, right - 1, bottom - 1), outline=(190, 195, 205), width=2)
    draw.text((left + 9, top + 7), str(label), fill=(30, 35, 45))


def _ecommerce_build_qc_reference_assets(batch, garment, profile):
    batch_cache_name = f"{_ecommerce_safe_name(batch.get('name') or '批次')}-{_ecommerce_safe_name(batch.get('id') or '')}"
    cache_dir = os.path.join(batch['output_path'], '_质检缓存', batch_cache_name, _ecommerce_safe_name(garment.get('name')))
    os.makedirs(cache_dir, exist_ok=True)
    overview_path = os.path.join(cache_dir, '六视图总览.jpg')
    detail_path = os.path.join(cache_dir, '关键细节拼图.jpg')

    if not os.path.isfile(overview_path):
        overview = Image.new('RGB', (1152, 1152), (244, 246, 248))
        for index, path in enumerate(garment.get('images', [])[:6]):
            with Image.open(path) as raw:
                image = ImageOps.exif_transpose(raw).convert('RGB')
                col, row = index % 3, index // 3
                cell = (col * 384, row * 576, (col + 1) * 384, (row + 1) * 576)
                _ecommerce_place_sheet_image(overview, image, cell, f'参考图{index + 1}')
        overview.save(overview_path, 'JPEG', quality=90, optimize=True)

    if not os.path.isfile(detail_path):
        regions = []
        for item in (profile.get('critical_regions') or []) if isinstance(profile, dict) else []:
            if not isinstance(item, dict):
                continue
            try:
                ref_index = int(item.get('reference_index')) - 1
                box = [float(v) for v in item.get('box_xyxy', [])]
            except (TypeError, ValueError):
                continue
            if 0 <= ref_index < len(garment.get('images', [])) and len(box) == 4:
                regions.append((ref_index, box, item.get('name') or '关键细节'))
            if len(regions) >= 6:
                break
        used_refs = {item[0] for item in regions}
        for ref_index in range(min(6, len(garment.get('images', [])))):
            if len(regions) >= 6:
                break
            if ref_index not in used_refs:
                regions.append((ref_index, None, '上身细节'))

        detail = Image.new('RGB', (1152, 768), (244, 246, 248))
        for index, (ref_index, box, name) in enumerate(regions[:6]):
            path = garment['images'][ref_index]
            with Image.open(path) as raw:
                image = ImageOps.exif_transpose(raw).convert('RGB')
                if box:
                    x1, y1, x2, y2 = box
                    x1, x2 = sorted((max(0, min(1000, x1)), max(0, min(1000, x2))))
                    y1, y2 = sorted((max(0, min(1000, y1)), max(0, min(1000, y2))))
                    margin_x = max(25, (x2 - x1) * 0.12)
                    margin_y = max(25, (y2 - y1) * 0.12)
                    crop_box = (
                        int(max(0, x1 - margin_x) / 1000 * image.width),
                        int(max(0, y1 - margin_y) / 1000 * image.height),
                        int(min(1000, x2 + margin_x) / 1000 * image.width),
                        int(min(1000, y2 + margin_y) / 1000 * image.height),
                    )
                    if crop_box[2] - crop_box[0] > 20 and crop_box[3] - crop_box[1] > 20:
                        image = image.crop(crop_box)
                else:
                    image = image.crop((0, 0, image.width, max(1, int(image.height * 0.62))))
                col, row = index % 3, index // 3
                cell = (col * 384, row * 384, (col + 1) * 384, (row + 1) * 384)
                _ecommerce_place_sheet_image(detail, image, cell, f'图{ref_index + 1} {name}')
        detail.save(detail_path, 'JPEG', quality=92, optimize=True)

    return {'overview': overview_path, 'details': detail_path}


def _ecommerce_get_garment_profile(batch_id, garment_id):
    lock = ecommerce_profile_locks.setdefault(f'{batch_id}:{garment_id}', threading.Lock())
    with lock:
        batch = _ecommerce_batch_snapshot(batch_id)
        garment = _ecommerce_find_garment(batch, garment_id) if batch else None
        if not garment:
            raise RuntimeError('服装数据不存在')
        if garment.get('profile'):
            assets = garment.get('qc_assets') or {}
            if not (os.path.isfile(assets.get('overview', '')) and os.path.isfile(assets.get('details', ''))):
                assets = _ecommerce_build_qc_reference_assets(batch, garment, garment['profile'])

                def save_assets(b):
                    g = _ecommerce_find_garment(b, garment_id)
                    if g:
                        g['qc_assets'] = assets
                _ecommerce_mutate_batch(batch_id, save_assets)
            return garment['profile']
        pre_profile_assets = _ecommerce_build_qc_reference_assets(batch, garment, {})
        settings = batch.get('settings') or {}
        profile_mode = settings.get('profile_mode') or 'visual_sheets'
        if profile_mode != 'ai_text':
            profile = {
                'profile_mode': 'visual_sheets',
                'views_summary': '参考图1～6已缓存为六视图总览和关键细节拼图',
                'garment_summary': '质检以六视图总览与关键细节拼图为服装真值',
                'critical_identity_features': [],
                'note': '不调用AI文字建档；候选质检直接查看视觉证据',
            }

            def save_visual_profile(b):
                g = _ecommerce_find_garment(b, garment_id)
                if g:
                    g['profile'] = profile
                    g['profile_error'] = ''
                    g['qc_assets'] = pre_profile_assets
                    g['qc_assets_error'] = ''
            _ecommerce_mutate_batch(batch_id, save_visual_profile)
            return profile

        model = settings.get('qc_model') or 'gemini-2.5-pro'
        prompt = '''你是服装电商款式建档专家。图1是同一件服装1～6号六视图总览，图2是六张图的上身细节。综合两图建档，细节采信图2、结构采信图1，看不到不等于不存在。每个值最多12个汉字；只输出一行，不要JSON、不要解释、不要换行，必须严格包含下面全部字段：
视角=1正全;2正特;3左45特;4右45特;5侧全;6背全|概括=款式概括|领口=形状细节|衣襟=结构位置|扣件=数量形状排列|拉链=数量位置或无|袖口=袖型袖口|开叉=数量位置|材质=材质肌理|花纹=花纹刺绣|颜色=主辅色|关键=最关键特征|不确定=不确定点或无'''
        try:
            _ecommerce_increment_usage(batch_id, 'profile_calls')
            profile = _ecommerce_vision_profile_line(model, prompt, [
                ('图1：六张服装参考总览', pre_profile_assets['overview']),
                ('图2：六张服装关键上身细节', pre_profile_assets['details']),
            ])
            required_profile_fields = ('views_summary', 'garment_summary', 'collar', 'placket', 'fasteners', 'zipper', 'material', 'pattern')
            missing_profile_fields = [key for key in required_profile_fields if not profile.get(key)]
            if missing_profile_fields:
                raise ValueError(f"服装建档文本不完整: {','.join(missing_profile_fields)}")
            error = ''
        except Exception as exc:
            profile = {'garment_summary': '自动建档失败，质检时直接综合六张参考图', 'critical_identity_features': []}
            error = str(exc)
        try:
            assets = _ecommerce_build_qc_reference_assets(batch, garment, profile)
            asset_error = ''
        except Exception as exc:
            assets = {}
            asset_error = str(exc)

        def save_profile(b):
            g = _ecommerce_find_garment(b, garment_id)
            if g:
                g['profile'] = profile
                g['profile_error'] = error
                g['qc_assets'] = assets
                g['qc_assets_error'] = asset_error
        _ecommerce_mutate_batch(batch_id, save_profile)
        return profile


def _ecommerce_qc_candidate(batch, garment, action, candidate_path):
    settings = batch.get('settings') or {}
    if not settings.get('qc_enabled', True):
        return {'passed': True, 'overall_score': 100, 'confidence': 1, 'critical_errors': [], 'correction_prompt': ''}
    profile = _ecommerce_get_garment_profile(batch['id'], garment['id'])
    latest_batch = _ecommerce_batch_snapshot(batch['id']) or batch
    latest_garment = _ecommerce_find_garment(latest_batch, garment['id']) or garment
    assets = latest_garment.get('qc_assets') or {}
    threshold = int(settings.get('qc_threshold') or 85)
    prompt = f'''你是严格的服装电商款式质检员。图1是同一套服装六张实拍的编号总览，图2是从六张实拍中提取的关键细节拼图，图3是AI换装候选图。先判断候选图的角度和景别，再综合总览与细节拼图核对；不得只看文字档案。动作、背景、道具轻微变化不重要；服装款式必须正确。
服装真值档案：{json.dumps(profile, ensure_ascii=False)}
重点核查领口形状、衣襟结构与位置、盘扣数量/形状/排列、拉链数量与位置、材质和花纹。看不见的部位标记occluded，不得凭空判错；候选图中清晰可见且与参考证据矛盾才算关键错误。只输出JSON：
{{"verdict":"pass或fail", "candidate_view":{{"orientation":"","framing":""}}, "matched_reference_indices":[], "overall_score":0, "confidence":0.0, "scores":{{"collar":0,"placket":0,"frog_buttons":0,"zipper":0,"material":0,"pattern":0}}, "occluded_items":[], "critical_errors":[], "observations":[], "correction_prompt":"给下一次生成使用的简短中文纠错要求"}}
通过标准：没有关键款式错误，且总分及所有可判断重点项均不低于{threshold}。'''
    if os.path.isfile(assets.get('overview', '')) and os.path.isfile(assets.get('details', '')):
        sources = [('六张服装参考总览', assets['overview']), ('服装关键细节拼图', assets['details']), ('AI换装候选图', candidate_path)]
        reference_mode = 'profile_plus_two_sheets'
    else:
        sources = [(f'真实服装参考图{i + 1}', p) for i, p in enumerate(garment['images'])]
        sources.append(('AI换装候选图', candidate_path))
        reference_mode = 'six_originals_fallback'
        prompt = prompt.replace(
            '图1是同一套服装六张实拍的编号总览，图2是从六张实拍中提取的关键细节拼图，图3是AI换装候选图。',
            '前六张是同一套服装的原始多角度实拍参考，最后一张是AI换装候选图。'
        )
    _ecommerce_increment_usage(batch['id'], 'qc_calls')
    report = _ecommerce_vision_json(settings.get('qc_model') or 'gemini-2.5-pro', prompt, sources)
    if report.get('_json_repaired'):
        _ecommerce_increment_usage(batch['id'], 'qc_repair_calls')
    report['input_image_count'] = len(sources)
    report['reference_mode'] = reference_mode
    scores = report.get('scores') if isinstance(report.get('scores'), dict) else {}
    numeric_scores = [float(v) for v in scores.values() if isinstance(v, (int, float))]
    errors = report.get('critical_errors') if isinstance(report.get('critical_errors'), list) else []
    overall = float(report.get('overall_score') or 0)
    passed = (
        str(report.get('verdict') or '').lower() == 'pass'
        and not errors
        and overall >= threshold
        and all(score >= threshold for score in numeric_scores)
    )
    report['passed'] = passed
    return report


def _ecommerce_download_candidate(batch, task, attempt_no, result_item):
    batch_cache_name = f"{_ecommerce_safe_name(batch.get('name') or '批次')}-{_ecommerce_safe_name(batch.get('id') or '')}"
    work_dir = os.path.join(batch['output_path'], '_运行缓存', batch_cache_name, task['garment_name'], f"目标图{task['action_order'] + 1:02d}")
    os.makedirs(work_dir, exist_ok=True)
    raw = None
    content_type = 'image/png'
    if isinstance(result_item, dict) and result_item.get('b64_json'):
        raw = base64.b64decode(result_item['b64_json'])
    else:
        url = result_item.get('url') if isinstance(result_item, dict) else str(result_item or '')
        ok, err, _ = _validate_url(url, ALLOWED_IMAGE_DOMAINS)
        if not ok:
            raise RuntimeError(f'结果URL不允许: {err}')
        with ecommerce_candidate_download_semaphore:
            resp = requests.get(url, timeout=(15, 120), stream=True)
            if resp.status_code != 200:
                raise RuntimeError(f'下载候选图HTTP {resp.status_code}')
            content_type = resp.headers.get('Content-Type', content_type)
            buf = io.BytesIO()
            for chunk in resp.iter_content(65536):
                buf.write(chunk)
                if buf.tell() > 40 * 1024 * 1024:
                    raise RuntimeError('候选图超过40MB')
            raw = buf.getvalue()
    ext = '.png' if 'png' in content_type else '.jpg'
    try:
        with Image.open(io.BytesIO(raw)) as img:
            ext = '.png' if (img.format or '').upper() == 'PNG' else '.jpg'
    except Exception:
        pass
    path = os.path.join(work_dir, f'候选{attempt_no}{ext}')
    with open(path, 'wb') as f:
        f.write(raw)
    return path


def _ecommerce_candidate_output_spec(candidate_path, action):
    """核验实际像素和比例，避免把“请求4K但实际1K”当作合格4K归档。"""
    requested_resolution = str(action.get('resolution') or '').lower()
    if not requested_resolution:
        model_key = str(action.get('model_key') or action.get('model_id') or '').lower()
        if model_key.endswith('/4k'):
            requested_resolution = '4k'
        elif model_key.endswith('/2k'):
            requested_resolution = '2k'
    requested_ratio = str(action.get('aspect_ratio') or 'auto').lower()
    with Image.open(candidate_path) as image:
        width, height = image.size
    long_edge = max(width, height)
    min_long_edge = {'2k': 1800, '4k': 3200}.get(requested_resolution, 0)
    resolution_ok = not min_long_edge or long_edge >= min_long_edge

    expected_ratio = None
    ratio_label = requested_ratio
    if requested_ratio == 'auto':
        try:
            action_source = _ecommerce_resolve_image_source(action.get('action_image'))
            with Image.open(action_source) as reference:
                expected_ratio = reference.width / reference.height
            ratio_label = '跟随目标图'
        except Exception:
            expected_ratio = None
    elif ':' in requested_ratio:
        try:
            ratio_w, ratio_h = requested_ratio.split(':', 1)
            expected_ratio = float(ratio_w) / float(ratio_h)
        except (TypeError, ValueError, ZeroDivisionError):
            expected_ratio = None
    actual_ratio = width / height if height else 0
    ratio_error = abs(actual_ratio - expected_ratio) / expected_ratio if expected_ratio else 0
    ratio_ok = expected_ratio is None or ratio_error <= 0.03
    errors = []
    if not resolution_ok:
        errors.append(f'请求{requested_resolution.upper()}，实际{width}×{height}，未达到真实{requested_resolution.upper()}门槛')
    if not ratio_ok:
        errors.append(f'请求比例{ratio_label}，实际{width}:{height}（偏差{ratio_error * 100:.1f}%）')
    return {
        'passed': resolution_ok and ratio_ok,
        'requested_resolution': requested_resolution,
        'requested_ratio': requested_ratio,
        'width': width,
        'height': height,
        'long_edge': long_edge,
        'resolution_ok': resolution_ok,
        'ratio_ok': ratio_ok,
        'ratio_error': round(ratio_error, 4),
        'errors': errors,
    }


def _ecommerce_internal_route_data(route_func, path, body):
    with app.test_request_context(path, method='POST', json=body):
        return _jsonify_route_result_to_data(route_func())


ECOMMERCE_GPT_SIZES = {
    '2k': {
        '1:1': '2048x2048', '2:3': '1376x2064', '3:2': '2064x1376',
        '3:4': '1536x2048', '4:3': '2048x1536', '4:5': '1664x2080',
        '5:4': '2080x1664', '9:16': '1152x2048', '16:9': '2048x1152', '21:9': '2016x864',
    },
    '4k': {
        '1:1': '2880x2880', '2:3': '2336x3504', '3:2': '3504x2336',
        '3:4': '2448x3264', '4:3': '3264x2448', '4:5': '2560x3200',
        '5:4': '3200x2560', '9:16': '2160x3840', '16:9': '3840x2160', '21:9': '3808x1632',
    },
}


def _ecommerce_gpt_auto_size(action):
    """自动比例仍锁定2K/4K档：从目标图推断最接近的官方尺寸，而不是向上游发送 size=auto。"""
    model_key = str(action.get('model_key') or action.get('model_id') or '').lower()
    tier = '4k' if model_key.endswith('/4k') else '2k' if model_key.endswith('/2k') else ''
    sizes = ECOMMERCE_GPT_SIZES.get(tier)
    if not sizes:
        return 'auto'
    try:
        source = _ecommerce_resolve_image_source(action.get('action_image'))
        with Image.open(source) as image:
            target_ratio = image.width / image.height
        def ratio_distance(item):
            label, _ = item
            width, height = (float(v) for v in label.split(':', 1))
            return abs((width / height) - target_ratio) / target_ratio
        return min(sizes.items(), key=ratio_distance)[1]
    except Exception:
        return sizes['3:4']


def _ecommerce_attempt_is_submitted(attempt):
    """Whether an upstream request exists and must still be polled after cancel."""
    return bool((attempt or {}).get('request_id')) and not bool((attempt or {}).get('candidate_path'))


def _ecommerce_task_has_inflight_request(task):
    return any(_ecommerce_attempt_is_submitted(attempt) for attempt in (task or {}).get('attempts') or [])


def _ecommerce_task_has_unarchived_candidate(task):
    return any(
        bool(attempt.get('candidate_path')) and not bool(attempt.get('archived_path'))
        for attempt in (task or {}).get('attempts') or []
    )


def _ecommerce_generate_candidate(batch, task, garment, action, prompt, attempt):
    garment_images = list(garment.get('images') or [])
    generation_mode = _ecommerce_generation_mode(batch, garment)
    # 原图批量提示词模式中，当前服装图本身就是唯一图生图输入；
    # 普通换装模式才传“目标图+服装参考图”。
    single_source_mode = generation_mode in {'target_only', 'garment_prompt'}
    action_image = str(action.get('action_image') or '').strip()
    if not action_image:
        raise RuntimeError('目标参考图（action_image）缺失，无法生图；请改用细节修复模式或重新选择目标参考图')
    batch_status = (batch or {}).get('status')
    if batch_status == 'cancelling' and not _ecommerce_attempt_is_submitted(attempt):
        raise InterruptedError('批次正在取消，未提交的新任务不再发送')
    if single_source_mode:
        sources = [action_image]
    elif bool((batch.get('settings') or {}).get('precision_matching')):
        reference_index = int(action.get('garment_reference_index') if action.get('garment_reference_index') is not None else -1)
        if reference_index < 0:
            sources = [action_image]
        elif reference_index >= len(garment_images):
            raise RuntimeError(
                f'精准匹配缺少服装参考图序号 {reference_index + 1}：{garment.get("name") or garment.get("id")}'
            )
        else:
            sources = [action_image, garment_images[reference_index]]
    else:
        sources = [action_image, *garment_images]
    attempt['mode'] = (
        'garment-prompt-edit' if generation_mode == 'garment_prompt'
        else 'target-only-edit' if generation_mode == 'target_only'
        else 'garment-reference-edit'
    )
    platform = str(action.get('platform') or 'oaihk').lower()

    if platform == 'runninghub':
        image_data = [_ecommerce_upload_runninghub_reference(batch['id'], source) for source in sources]
        if len(image_data) > int(action.get('max_images') or 10):
            raise RuntimeError(f"RunningHub模型最多接收{action.get('max_images') or 10}张参考图")
        if attempt.get('request_id'):
            task_id = attempt['request_id']
        else:
            params = {
                'prompt': prompt,
                'imageUrls': image_data,
                'resolution': str(action.get('resolution') or '2k').lower(),
            }
            quality = str(action.get('quality') or '').lower()
            if quality in ('low', 'medium', 'high'):
                params['quality'] = quality
            aspect_ratio = str(action.get('aspect_ratio') or 'auto')
            # RunningHub 2026-01-15 起不再接受 auto 枚举；省略字段才是自适应参考图。
            if aspect_ratio != 'auto':
                params['aspectRatio'] = aspect_ratio
            data, status = _ecommerce_internal_route_data(rh_proxy, '/api/rh-proxy', {
                'action': 'submit',
                'model_id': action.get('endpoint') or action.get('model_id') or action.get('model_key'),
                'params': params,
            })
            if not (200 <= status < 300) or not data.get('taskId'):
                # 提交请求已经发出但没有拿到 taskId 时，无法判断供应商是否已扣费。
                # 这种情况下禁止自动再次 submit，避免网络丢包造成重复扣费。
                attempt['status'] = 'submission_uncertain'
                attempt['submission_uncertain'] = True
                attempt['submission_error'] = data.get('errorMessage') or data.get('error') or data.get('message') or f'RunningHub提交HTTP {status}'
                _ecommerce_mutate_batch(batch['id'], lambda b: _ecommerce_sync_attempt(b, task['id'], attempt))
                raise RuntimeError(f"提交结果不确定，已停止自动重投：{attempt['submission_error']}")
            task_id = data['taskId']
            _ecommerce_increment_usage(batch['id'], 'generation_requests')
            attempt['request_id'] = task_id
            attempt['provider'] = 'runninghub'
            attempt['status'] = 'submitted'
            _ecommerce_mutate_batch(batch['id'], lambda b: _ecommerce_sync_attempt(b, task['id'], attempt))

        started = time.time()
        delay = 2
        while time.time() - started < 3600:
            current = _ecommerce_batch_snapshot(batch['id'])
            if not current or current.get('status') in ('paused', 'cancelled'):
                raise InterruptedError(current.get('status') if current else '批次不存在')
            data, status = _ecommerce_internal_route_data(rh_proxy, '/api/rh-proxy', {
                'action': 'query', 'task_id': task_id,
            })
            state = str(data.get('status') or '').upper()
            results = data.get('results') or []
            if 200 <= status < 300 and (state == 'SUCCESS' or results) and results:
                _ecommerce_record_runninghub_usage(batch['id'], task['id'], attempt, data)
                return _ecommerce_download_candidate(batch, task, attempt['number'], results[0])
            if state in ('FAILED', 'ERROR', 'CANCELLED') or data.get('error') or data.get('errorMessage'):
                raise RuntimeError(data.get('errorMessage') or data.get('error') or data.get('message') or f'RunningHub任务{state}')
            # 按任务序号错峰，避免100个任务在同一秒形成查询尖峰。
            time.sleep(delay + (int(task.get('order') or 0) % 5) * 0.35)
            delay = min(15, delay + 2)
        raise TimeoutError('RunningHub任务轮询超过60分钟')

    if action.get('is_gpt_image'):
        requested_size = action.get('size') or 'auto'
        if requested_size == 'auto':
            requested_size = _ecommerce_gpt_auto_size(action)
        image_data = [_ecommerce_image_data_uri(s, max_long_edge=max(1024, int(action.get('short_edge') or 1536))) for s in sources]
        data, status = _ecommerce_internal_route_data(oaihk_gpt_image, '/api/oaihk-gpt-image', {
            'action': 'edits',
            'model': action.get('model_id') or 'gpt-image-2',
            'prompt': prompt,
            'size': requested_size,
            'quality': action.get('quality') or 'medium',
            'n': 1,
            'image_base64_list': image_data,
        })
        _ecommerce_increment_usage(batch['id'], 'generation_requests')
        if not (200 <= status < 300):
            raise RuntimeError(data.get('error') or f'GPT生成HTTP {status}')
        items = data.get('data') or []
        if not items:
            raise RuntimeError('GPT没有返回图片')
        return _ecommerce_download_candidate(batch, task, attempt['number'], items[0])

    public_urls = [_ecommerce_upload_public_reference(batch['id'], s) for s in sources]
    if attempt.get('request_id'):
        request_id = attempt['request_id']
    else:
        params = {
            'prompt': prompt,
            'image_urls': public_urls,
            'num_images': 1,
        }
        aspect_ratio = action.get('aspect_ratio') or 'auto'
        if aspect_ratio != 'auto':
            params['aspect_ratio'] = aspect_ratio
        data, status = _ecommerce_internal_route_data(oaihk_proxy, '/api/oaihk-proxy', {
            'action': 'submit',
            'endpoint': action.get('endpoint'),
            'model_id': action.get('model_id') or action.get('model_key'),
            'params': params,
        })
        if not (200 <= status < 300) or not data.get('request_id'):
            attempt['status'] = 'submission_uncertain'
            attempt['submission_uncertain'] = True
            attempt['submission_error'] = data.get('error') or f'HK提交HTTP {status}'
            _ecommerce_mutate_batch(batch['id'], lambda b: _ecommerce_sync_attempt(b, task['id'], attempt))
            raise RuntimeError(f"提交结果不确定，已停止自动重投：{attempt['submission_error']}")
        request_id = data['request_id']
        _ecommerce_increment_usage(batch['id'], 'generation_requests')
        attempt['request_id'] = request_id
        attempt['status'] = 'submitted'
        _ecommerce_mutate_batch(batch['id'], lambda b: _ecommerce_sync_attempt(b, task['id'], attempt))

    poll_endpoint = action.get('poll_endpoint') or 'fal-ai/nano-banana/requests'
    started = time.time()
    delay = 2
    while time.time() - started < 3600:
        current = _ecommerce_batch_snapshot(batch['id'])
        if not current or current.get('status') in ('paused', 'cancelled'):
            raise InterruptedError(current.get('status') if current else '批次不存在')
        data, status = _ecommerce_internal_route_data(oaihk_proxy, '/api/oaihk-proxy', {
            'action': 'poll', 'poll_endpoint': poll_endpoint, 'request_id': request_id,
        })
        if 200 <= status < 300 and data.get('images'):
            return _ecommerce_download_candidate(batch, task, attempt['number'], data['images'][0])
        state = str(data.get('status') or '').upper()
        if state in ('FAILED', 'ERROR', 'CANCELLED') or data.get('error'):
            raise RuntimeError(data.get('error') or f'HK任务{state}')
        time.sleep(delay)
        delay = min(10, delay + 1)
    raise TimeoutError('HK任务轮询超过60分钟')


def _ecommerce_sync_attempt(batch, task_id, attempt):
    task = _ecommerce_find_task(batch, task_id)
    if not task:
        return
    attempts = task.setdefault('attempts', [])
    attempt_id = str(attempt.get('id') or '')
    existing = next((
        a for a in attempts
        if (attempt_id and str(a.get('id') or '') == attempt_id)
        or (not attempt_id and a.get('number') == attempt.get('number'))
    ), None)
    if existing:
        existing.update(attempt)
    else:
        attempts.append(dict(attempt))
    task['updated_at'] = datetime.now().isoformat(timespec='seconds')


def _ecommerce_generation_needs_configuration(error):
    message = str(error or '').lower()
    markers = (
        'enterprise-shared', '企业级-共享', 'api key 未配置', 'api key未配置',
        'invalid api key', 'unauthorized', 'authentication failed',
        # 安全白名单拒绝属于确定性本地配置问题，重复上传不会恢复。
        '域名不在白名单',
    )
    return any(marker in message for marker in markers)


def _ecommerce_sample_result_dir(batch, garment):
    """Return the only directory where generated samples may be archived.

    The garment source directory is deliberately never a fallback. Historical
    batches without result_dirs continue in their recorded local result/cache
    directory so generated images cannot contaminate real clothing references.
    """
    mapped = (batch.get('result_dirs') or {}).get(garment.get('id'))
    fallback = ((batch.get('settings') or {}).get('archive_fallback_garments') or {}).get(garment.get('name'))
    if mapped or fallback:
        return os.path.realpath(os.path.expanduser(mapped or fallback))
    cache_root = os.path.realpath(os.path.expanduser(batch.get('output_path') or os.path.join(BASE_DIR, '_运行缓存')))
    garment_name = _ecommerce_safe_name(garment.get('name') or garment.get('id'), garment.get('id') or '服装')
    return os.path.join(cache_root, '_生成样本备份', garment_name)


def _ecommerce_result_root(batch, task):
    garment = _ecommerce_find_garment(batch, task.get('garment_id'))
    if not garment:
        raise RuntimeError('找不到任务对应的服装文件夹')
    root = _ecommerce_sample_result_dir(batch, garment)
    _ecommerce_ensure_directory(root)
    return root


def _ecommerce_unique_copy(source, target):
    # 锁住整个选名与复制过程，确保100路乱序返回也不会抢到同一个目标文件名。
    with ecommerce_archive_lock:
        base, ext = os.path.splitext(target)
        candidate = target
        suffix = 2
        while os.path.exists(candidate):
            candidate = f'{base}-{suffix}{ext}'
            suffix += 1
        return _ecommerce_copy_file(source, candidate)


def _ecommerce_archive_mismatch(batch, task, attempt):
    source = attempt.get('candidate_path')
    if not source or not os.path.isfile(source):
        return ''
    target_dir = os.path.join(_ecommerce_result_root(batch, task), '不匹配')
    _ecommerce_ensure_directory(target_dir)
    ext = os.path.splitext(source)[1] or '.png'
    action_name = _ecommerce_safe_name(task.get('action_name'), f"目标图{task.get('action_order', 0) + 1}")
    target = os.path.join(target_dir, f"目标图{task['action_order'] + 1:02d}-{action_name}-第{attempt['number']}次-不匹配{ext}")
    return _ecommerce_unique_copy(source, target)


def _ecommerce_archive_accepted(batch, task, candidate_path):
    target_dir = _ecommerce_result_root(batch, task)
    ext = os.path.splitext(candidate_path)[1] or '.png'
    action_name = _ecommerce_safe_name(task.get('action_name'), f"目标图{task.get('action_order', 0) + 1}")
    target = os.path.join(target_dir, f"目标图{task['action_order'] + 1:02d}-{action_name}-OK{ext}")
    return _ecommerce_unique_copy(candidate_path, target)


def _ecommerce_reserve_sample_target(target_dir, action_order, gen_type, ext, run_prefix='', fp_round=None):
    """Atomically reserve a parseable archive name before copying bytes.

    Sequence discovery and reservation must share one lock. Otherwise concurrent
    CK results can all discover CK01 and force _unique_copy to append an
    unstructured collision suffix.
    """
    _ecommerce_ensure_directory(target_dir)
    with ecommerce_archive_lock:
        if gen_type == 'first':
            idx = _ecommerce_next_sample_index(target_dir, action_order, 'first')
            round_num = 0
            make_name = lambda value: f"{run_prefix}AI-{action_order:02d}-{value:02d}{ext}"
        elif gen_type == 'ck':
            idx = _ecommerce_next_sample_index(target_dir, action_order, 'ck')
            round_num = 0
            make_name = lambda value: f"{run_prefix}AI-{action_order:02d}-CK{value:02d}{ext}"
        elif gen_type == 'fp':
            round_num = int(fp_round or _ecommerce_next_fp_round(target_dir, action_order))
            idx = _ecommerce_next_sample_index(target_dir, action_order, 'fp', fp_round=round_num)
            make_name = lambda value: f"{run_prefix}AI-{action_order:02d}-FP{round_num:02d}-{value:02d}{ext}"
        elif gen_type == 'fp_ck':
            round_num = int(fp_round or _ecommerce_next_fp_round(target_dir, action_order))
            idx = _ecommerce_next_sample_index(target_dir, action_order, 'fp_ck', fp_round=round_num)
            make_name = lambda value: f"{run_prefix}AI-{action_order:02d}-FP{round_num:02d}-CK{value:02d}{ext}"
        elif gen_type == 'bj':
            idx = _ecommerce_next_sample_index(target_dir, action_order, 'bj')
            round_num = int(fp_round or 0)
            make_name = lambda value: f"{run_prefix}AI-{action_order:02d}-BJ{value:02d}{ext}"
        else:
            idx = _ecommerce_next_sample_index(target_dir, action_order, 'first')
            round_num = 0
            make_name = lambda value: f"{run_prefix}AI-{action_order:02d}-{value:02d}{ext}"
        while True:
            target = os.path.join(target_dir, make_name(idx))
            try:
                with open(target, 'xb'):
                    pass
                return target, idx, round_num
            except FileExistsError:
                idx += 1


def _ecommerce_write_asset_manifest(batch_id, garment_id):
    # 快照获取和落盘共享一把锁，避免并发归档时旧快照后写覆盖新快照。
    with ecommerce_archive_lock:
        batch = _ecommerce_batch_snapshot(batch_id)
        garment = _ecommerce_find_garment(batch, garment_id) if batch else None
        result_dir = _ecommerce_sample_result_dir(batch, garment) if batch and garment else ''
        if not result_dir:
            return ''
        assets = [
            row for row in batch.get('result_assets') or []
            if row.get('garment_id') == garment_id
        ]
        payload = {
            'schema': 1,
            'batch_id': batch_id,
            'garment_id': garment_id,
            'updated_at': datetime.now().isoformat(timespec='seconds'),
            'assets': assets,
        }
        return _ecommerce_write_json_file(os.path.join(result_dir, 'asset-manifest.json'), payload)


def _ecommerce_register_result_asset(batch, task, path, gen_type, fp_round, candidate_index, total_samples):
    """Register one archived file as the primary machine-readable identity."""
    batch_id = str(batch.get('id') or '')
    garment_id = str(task.get('garment_id') or '')
    if not batch_id or not garment_id or not path:
        return None
    action_order = int(task.get('action_order') or 0) + 1
    real_path = os.path.realpath(os.path.expanduser(path))
    row = {
        'asset_id': gen_id('ecasset'),
        'batch_id': batch_id,
        'garment_id': garment_id,
        'task_id': task.get('id') or '',
        'action_id': task.get('action_id') or '',
        'action_order': action_order,
        'generation_kind': str(gen_type or 'first'),
        'round': int(fp_round or 0),
        'candidate_index': int(candidate_index or 1),
        'requested_count': max(1, int(total_samples or 1)),
        'path': real_path,
        'status': 'active',
        'created_at': datetime.now().isoformat(timespec='seconds'),
    }
    def register(stored_batch):
        assets = stored_batch.setdefault('result_assets', [])
        existing = next((asset for asset in assets if os.path.realpath(os.path.expanduser(asset.get('path') or '')) == real_path), None)
        if existing:
            existing.update({key: value for key, value in row.items() if key != 'asset_id'})
            return existing
        assets.append(row)
        return row
    registered = _ecommerce_mutate_batch(batch_id, register)
    try:
        _ecommerce_write_asset_manifest(batch_id, garment_id)
    except Exception as exc:
        logger.warning('[ecommerce-assets] 写资产清单失败: %s', exc)
    return registered


def _ecommerce_set_result_asset_status(batch_id, garment_id, path, status):
    real_path = os.path.realpath(os.path.expanduser(path or ''))
    if not real_path:
        return
    def update(stored_batch):
        for asset in stored_batch.get('result_assets') or []:
            if (
                asset.get('garment_id') == garment_id
                and os.path.realpath(os.path.expanduser(asset.get('path') or '')) == real_path
            ):
                asset['status'] = status
                asset['updated_at'] = datetime.now().isoformat(timespec='seconds')
    _ecommerce_mutate_batch(batch_id, update)
    try:
        _ecommerce_write_asset_manifest(batch_id, garment_id)
    except Exception as exc:
        logger.warning('[ecommerce-assets] 更新资产清单失败: %s', exc)


def _ecommerce_archive_sample(batch, task, candidate_path, sample_number, total_samples, run_code_override=None, gen_type=None, fp_round=None):
    """把生成样本归档到结果目录。

    新命名规则（gen_type 参数控制）：
      - 'first'(默认,首次单张)：<run_code>-AI-XX-01.jpg
      - 'ck'(首次抽卡)：<run_code>-AI-XX-CKNN.jpg（NN=01,02,...）
      - 'fp'(废片重做单张)：<run_code>-AI-XX-FPN-01.jpg（N=轮次1,2,3...）
      - 'fp_ck'(废片重做抽卡)：<run_code>-AI-XX-FPN-CKNN.jpg
      - 'bj'(标记重做)：<run_code>-AI-XX-BJNN.jpg
    未指定 gen_type 时，根据 total_samples 自动判断：
      total_samples=1 → 'first'（新格式 -01）
      total_samples>1 → 'ck'（新格式 -CKNN）
    注意：为兼容旧批次已有文件，归档前会扫描目录计算下一个可用序号，避免覆盖。
    """
    garment = _ecommerce_find_garment(batch, task.get('garment_id'))
    if not garment:
        raise RuntimeError('找不到任务对应的服装文件夹')
    garment_name = _ecommerce_safe_name(garment.get('name') or garment.get('id'), garment.get('id') or '服装')
    cache_root = os.path.expanduser(batch.get('output_path') or '')
    backup_dir = os.path.join(cache_root, '_生成样本备份', garment_name) if cache_root else ''
    target_dir = _ecommerce_sample_result_dir(batch, garment)
    if not target_dir:
        raise RuntimeError('批次没有可用的AI结果目录或本地备份目录')
    _ecommerce_ensure_directory(target_dir)
    ext = os.path.splitext(candidate_path)[1] or '.jpg'
    action_order = int(task.get('action_order') or 0) + 1
    effective_run_code = str(run_code_override or batch.get('run_code') or '').strip()
    run_prefix = f"{effective_run_code}-" if effective_run_code else ''

    # 确定生成类型
    if gen_type is None:
        gen_type = 'ck' if int(total_samples or 1) > 1 else 'first'

    target, idx, round_num = _ecommerce_reserve_sample_target(
        target_dir, action_order, gen_type, ext, run_prefix=run_prefix, fp_round=fp_round,
    )
    filename = os.path.basename(target)

    # 不再创建预览备份和全分辨率备份。软删除模式下，文件保留在源目录直到
    # 重做提交时才移到回收站；对比界面通过缩略图端点按需加载，无需额外副本。
    # 仅当用户指定的成品目录不可写（如外置盘权限问题）时，回退到缓存备份目录。

    # 先尝试写入用户指定的成品目录（或正常的缓存结果目录）。
    try:
        archived = _ecommerce_copy_file(candidate_path, target)
        # 如果结果目录本身就是缓存备份目录（旧批次兼容），记录 fallback 设置。
        if backup_dir and os.path.realpath(target_dir) == os.path.realpath(backup_dir):
            batch_id = str(batch.get('id') or '')
            if batch_id:
                def _record_direct_cache_archive(
                    b,
                    base_path=os.path.dirname(target_dir),
                    garment_path=target_dir,
                    stored_garment_name=str(garment.get('name') or ''),
                ):
                    settings = b.setdefault('settings', {})
                    settings['archive_fallback'] = True
                    settings['archive_fallback_root'] = base_path
                    settings.setdefault('archive_fallback_garments', {})[stored_garment_name] = garment_path
                _ecommerce_mutate_batch(batch_id, _record_direct_cache_archive)
        _ecommerce_register_result_asset(batch, task, archived, gen_type, round_num, idx, total_samples)
        return archived
    except (PermissionError, OSError) as exc:
        try:
            # target 是本次调用原子预留的专用文件；复制失败时即使
            # 已写入部分字节也必须删除，避免损坏图被扫描成有效候选。
            if os.path.isfile(target):
                os.remove(target)
        except OSError:
            pass
        # 成品目录不可写（如外置盘权限问题），回退到应用缓存备份目录。
        if not backup_dir or os.path.realpath(target_dir) == os.path.realpath(backup_dir):
            raise RuntimeError(f'结果目录不可写且无缓存备份可用: {exc}') from exc
        logger.warning(
            '[ecommerce-archive-sample] 成品目录不可写，回退到缓存: source=%s fallback=%s error=%s',
            target_dir, backup_dir, exc,
        )
        os.makedirs(backup_dir, exist_ok=True)
        backup_path, idx, round_num = _ecommerce_reserve_sample_target(
            backup_dir, action_order, gen_type, ext, run_prefix=run_prefix, fp_round=fp_round,
        )
        try:
            backup_archived = _ecommerce_copy_file(candidate_path, backup_path)
        except Exception:
            try:
                if os.path.isfile(backup_path):
                    os.remove(backup_path)
            except OSError:
                pass
            raise
        batch_id = str(batch.get('id') or '')
        if batch_id:
            def _record_archive_fallback(
                b,
                base_path=os.path.dirname(backup_archived),
                garment_path=backup_dir,
                garment_name=str(garment.get('name') or ''),
                error=str(exc),
            ):
                settings = b.setdefault('settings', {})
                settings['archive_fallback'] = True
                settings['archive_fallback_root'] = base_path
                settings['archive_fallback_reason'] = error
                settings.setdefault('archive_fallback_garments', {})[garment_name] = garment_path
            _ecommerce_mutate_batch(batch_id, _record_archive_fallback)
        _ecommerce_register_result_asset(batch, task, backup_archived, gen_type, round_num, idx, total_samples)
        return backup_archived


def _ecommerce_repair_legacy_rerun_archives(batch_id):
    """Move legacy reruns out of garment reference folders and fix model codes.

    This is an idempotent maintenance helper for batches produced before reruns
    were forced into the recorded result directory. A source is removed only
    after the destination checksum is verified.
    """
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        raise ValueError('找不到批次')
    repairs = []
    for task in batch.get('tasks') or []:
        garment = _ecommerce_find_garment(batch, task.get('garment_id'))
        if not garment:
            continue
        garment_root = os.path.realpath(os.path.expanduser(garment.get('path') or ''))
        result_dir = _ecommerce_sample_result_dir(batch, garment)
        os.makedirs(result_dir, exist_ok=True)
        action_order = int(task.get('action_order') or 0) + 1
        for attempt in task.get('attempts') or []:
            if not attempt.get('rerun'):
                continue
            old_path = os.path.realpath(os.path.expanduser(attempt.get('archived_path') or ''))
            signature = attempt.get('model_signature') or task.get('result_model') or {}
            run_code = '-'.join(_ecommerce_run_code_parts(signature)) + '-RR'
            old_ext = os.path.splitext(old_path)[1] if old_path else ''
            candidate_ext = os.path.splitext(attempt.get('candidate_path') or '')[1]
            ext = old_ext or candidate_ext or '.jpg'
            target = os.path.join(result_dir, f'{run_code}-AI-{action_order:02d}{ext}')
            if (
                old_path
                and os.path.realpath(old_path) == os.path.realpath(target)
                and os.path.isfile(old_path)
                and signature.get('run_code') == run_code
            ):
                continue
            old_backup = os.path.join(result_dir, os.path.basename(old_path)) if old_path else ''
            source = next((path for path in (old_path, old_backup, attempt.get('candidate_path')) if path and os.path.isfile(path)), '')
            if not source:
                continue
            if os.path.isfile(target):
                if _file_sha256(source) != _file_sha256(target):
                    target = _ecommerce_unique_copy(source, target)
            else:
                target = _ecommerce_copy_file(source, target)
            target_hash = _file_sha256(target)
            removed = []
            for obsolete in dict.fromkeys((old_path, old_backup)):
                if not obsolete or os.path.realpath(obsolete) == os.path.realpath(target) or not os.path.isfile(obsolete):
                    continue
                if _file_sha256(obsolete) == target_hash:
                    os.remove(obsolete)
                    removed.append(obsolete)
            repairs.append({
                'task_id': task.get('id'), 'old_path': old_path, 'new_path': target,
                'run_code': run_code, 'removed': removed,
                'was_in_garment_dir': bool(garment_root and old_path.startswith(garment_root + os.sep)),
            })
    if repairs:
        by_task = {item['task_id']: item for item in repairs}
        def store_repairs(stored_batch):
            for stored_task in stored_batch.get('tasks') or []:
                repair = by_task.get(stored_task.get('id'))
                if not repair:
                    continue
                for stored_attempt in reversed(stored_task.get('attempts') or []):
                    if stored_attempt.get('rerun') and os.path.realpath(os.path.expanduser(stored_attempt.get('archived_path') or '')) == repair['old_path']:
                        stored_attempt['archived_path'] = repair['new_path']
                        stored_attempt.setdefault('model_signature', {})['run_code'] = repair['run_code']
                        break
                stored_task.setdefault('result_model', {})['run_code'] = repair['run_code']
        _ecommerce_mutate_batch(batch_id, store_repairs)
    return {'batch_id': batch_id, 'repaired': len(repairs), 'items': repairs}


def _ecommerce_scan_missing_samples(garment_path, action_count, samples_per_action=1):
    """扫描这套服装的 AI 结果文件夹，返回缺失有效成品的动作编号列表。

    判断标准：每个动作至少有1张有效成品图（is_valid_result=True，BJ返回图也有效），
    且排除软删除的文件。只要≥1张有效图即视为该动作不缺。
    注意：samples_per_action 参数保留兼容，但新逻辑以"每动作至少1张有效图"为标准，
    抽卡多张保留是用户选择，不影响是否缺图判断。
    """
    missing = []
    if not garment_path or not os.path.isdir(garment_path):
        return list(range(1, action_count + 1))
    try:
        names = os.listdir(garment_path)
    except OSError:
        return list(range(1, action_count + 1))
    # 收集软删除文件路径集合（软删除的文件仍在磁盘上，但不算有效图）
    # 注意：此函数是纯文件系统扫描，不读取deleted_samples台账。
    # 台账扫描在调用方（ecommerce_scan_deleted）中合并处理。
    valid_counts = {}
    for name in names:
        if name.lower().endswith('.deleted'):
            continue
        if not os.path.isfile(os.path.join(garment_path, name)):
            continue
        identity = _ecommerce_sample_identity(name)
        if not identity:
            continue
        if not identity.get('is_valid_result', False):
            # 只排除无效/未知类型；BJ返回图的 is_valid_result=True。
            continue
        order = identity['action_order']
        valid_counts[order] = valid_counts.get(order, 0) + 1
    for i in range(1, action_count + 1):
        if valid_counts.get(i, 0) < 1:
            missing.append(i)
    return missing


def _ecommerce_count_valid_samples(garment_path, action_order):
    """统计指定动作在结果目录中实际存在的有效成品数量（包含BJ返回图）。"""
    if not garment_path or not os.path.isdir(garment_path):
        return 0
    try:
        names = os.listdir(garment_path)
    except OSError:
        return 0
    count = 0
    for name in names:
        if name.lower().endswith('.deleted'):
            continue
        if not os.path.isfile(os.path.join(garment_path, name)):
            continue
        identity = _ecommerce_sample_identity(name)
        if not identity:
            continue
        if identity['action_order'] != action_order:
            continue
        if not identity.get('is_valid_result', False):
            continue
        count += 1
    return count


def _ecommerce_count_samples_per_action(garment_path, action_order):
    """统计指定动作在结果目录中实际存在的样本总数（含BJ，兼容旧调用）。"""
    if not garment_path or not os.path.isdir(garment_path):
        return 0
    try:
        names = os.listdir(garment_path)
    except OSError:
        return 0
    count = 0
    for name in names:
        if name.lower().endswith('.deleted'):
            continue
        if not os.path.isfile(os.path.join(garment_path, name)):
            continue
        identity = _ecommerce_sample_identity(name)
        if identity and identity['action_order'] == action_order:
            count += 1
    return count


def _ecommerce_archive_manual_review(batch, task):
    root = _ecommerce_result_root(batch, task)
    action_name = _ecommerce_safe_name(task.get('action_name'), f"目标图{task.get('action_order', 0) + 1}")
    review_dir = os.path.join(root, '_人工补齐暂存', f"目标图{task['action_order'] + 1:02d}-{action_name}")
    _ecommerce_ensure_directory(review_dir)
    for attempt in task.get('attempts', []):
        path = attempt.get('candidate_path')
        if path and os.path.isfile(path):
            ext = os.path.splitext(path)[1] or '.png'
            target = os.path.join(review_dir, f"第{attempt.get('number', 0)}次-不匹配{ext}")
            if not os.path.exists(target):
                _ecommerce_copy_file(path, target)
    _ecommerce_write_json_file(
        os.path.join(review_dir, '质检报告.json'),
        {'task': task, 'generated_at': datetime.now().isoformat()},
    )
    return review_dir


def _ecommerce_finalize_garment_outputs(batch_id, garment_id):
    batch = _ecommerce_batch_snapshot(batch_id)
    garment = _ecommerce_find_garment(batch, garment_id) if batch else None
    if not batch or not garment:
        return
    tasks = [t for t in batch.get('tasks', []) if t.get('garment_id') == garment_id]
    if not tasks:
        return
    probe_task = tasks[0]
    root = _ecommerce_result_root(batch, probe_task)
    all_final = all(t.get('state') in ECOMMERCE_FINAL_TASK_STATES for t in tasks)
    manual = [t for t in tasks if t.get('state') == 'manual_review']
    staging = os.path.join(root, '_人工补齐暂存')
    if all_final and manual and os.path.isdir(staging):
        final_review = os.path.join(root, f'有{len(manual)}张需要人工补齐')
        if os.path.exists(final_review):
            _ecommerce_copytree(staging, final_review)
            _ecommerce_remove_path(staging)
        else:
            _ecommerce_move_path(staging, final_review)

        def update_review_paths(b):
            for item in b.get('tasks', []):
                if item.get('garment_id') == garment_id and item.get('manual_review_path'):
                    item['manual_review_path'] = item['manual_review_path'].replace(staging, final_review, 1)
        _ecommerce_mutate_batch(batch_id, update_review_paths)
        batch = _ecommerce_batch_snapshot(batch_id)
        tasks = [t for t in batch.get('tasks', []) if t.get('garment_id') == garment_id]
    elif all_final and not manual and os.path.isdir(staging):
        _ecommerce_remove_path(staging)

    record = {
        'batch_id': batch_id,
        'batch_name': batch.get('name'),
        'garment': garment.get('name'),
        'completed': all_final,
        'accepted_count': sum(t.get('state') == 'accepted' for t in tasks),
        'manual_review_count': sum(t.get('state') == 'manual_review' for t in tasks),
        'tasks': tasks,
        'updated_at': datetime.now().isoformat(timespec='seconds'),
    }
    _ecommerce_write_json_file(os.path.join(root, '批次质检记录.json'), record)


def _ecommerce_task_context(batch_id, task_id):
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return None, None, None, None
    task = _ecommerce_find_task(batch, task_id)
    garment = _ecommerce_find_garment(batch, task.get('garment_id')) if task else None
    action = next((a for a in (batch.get('template') or {}).get('actions', []) if a.get('id') == task.get('action_id')), None) if task else None
    return batch, task, garment, action


def _ecommerce_generate_task_attempt(batch_id, task_id, number):
    """Generate exactly one round candidate. QC is intentionally a separate phase."""
    batch, task, garment, action = _ecommerce_task_context(batch_id, task_id)
    if not task or not garment or not action or task.get('state') in ECOMMERCE_FINAL_TASK_STATES:
        return False
    if batch.get('status') in ('paused', 'cancelled'):
        return False

    max_attempts = int((batch.get('settings') or {}).get('max_attempts') or 3)
    if number < 1 or number > max_attempts:
        return False
    attempts = task.get('attempts') or []
    attempt = next((dict(item) for item in attempts if int(item.get('number') or 0) == number), None)
    if attempt and attempt.get('qc') is not None:
        return False
    if number > 1:
        previous = next((item for item in attempts if int(item.get('number') or 0) == number - 1), None)
        if not previous or not isinstance(previous.get('qc'), dict) or previous['qc'].get('passed'):
            return False
    if attempt is None:
        attempt = {
            'number': number,
            'status': 'preparing',
            'request_id': '',
            'candidate_path': '',
            'qc': None,
            'started_at': datetime.now().isoformat(timespec='seconds'),
        }

    candidate = attempt.get('candidate_path') if attempt.get('candidate_path') and os.path.isfile(attempt.get('candidate_path')) else None
    if candidate:
        attempt['status'] = 'awaiting_qc'
        _ecommerce_mutate_batch(batch_id, lambda b: (_ecommerce_set_task_state(b, task_id, 'awaiting_qc'), _ecommerce_sync_attempt(b, task_id, attempt)))
        return True

    prompt = action['prompt']
    if number > 1:
        previous = next((item for item in attempts if int(item.get('number') or 0) == number - 1), {})
        correction = str((previous.get('qc') or {}).get('correction_prompt') or '服装关键款式与六张实拍参考不一致')
        prompt += f"\n上一次服装质检发现：{correction}。本次必须修正这些服装款式问题。"

    _ecommerce_mutate_batch(batch_id, lambda b: (_ecommerce_set_task_state(b, task_id, 'preparing'), _ecommerce_sync_attempt(b, task_id, attempt)))
    generation_error = None
    for transport_try in range(3):
        try:
            batch, task, garment, action = _ecommerce_task_context(batch_id, task_id)
            candidate = _ecommerce_generate_candidate(batch, task, garment, action, prompt, attempt)
            break
        except InterruptedError:
            latest = _ecommerce_batch_snapshot(batch_id)
            if latest and latest.get('status') == 'cancelling':
                _ecommerce_mutate_batch(batch_id, lambda b: _ecommerce_set_task_state(b, task_id, 'cancelled'))
            return False
        except Exception as exc:
            generation_error = str(exc)
            if _ecommerce_generation_needs_configuration(generation_error):
                break
            if transport_try < 2:
                time.sleep(2 ** transport_try * 3)
    if not candidate:
        # 网络或平台临时错误不消耗候选轮次；恢复后继续同一个attempt/request_id。
        attempt['status'] = 'preparing'
        attempt['transport_failures'] = int(attempt.get('transport_failures') or 0) + 1
        attempt['error'] = generation_error or '生成失败'
        error_state = 'configuration_required' if _ecommerce_generation_needs_configuration(attempt['error']) else 'preparing'
        _ecommerce_mutate_batch(batch_id, lambda b: (_ecommerce_sync_attempt(b, task_id, attempt), _ecommerce_set_task_error(b, task_id, attempt['error'], state=error_state)))
        return False

    attempt['candidate_path'] = candidate
    output_spec = _ecommerce_candidate_output_spec(candidate, action)
    attempt['output_spec'] = output_spec
    if not output_spec.get('passed'):
        attempt['qc'] = {
            'passed': False,
            'verdict': 'technical_mismatch',
            'overall_score': 0,
            'critical_errors': output_spec.get('errors') or ['输出规格不匹配'],
            'correction_prompt': '',
            'output_spec': output_spec,
        }
        attempt['status'] = 'spec_failed'
        attempt['finished_at'] = datetime.now().isoformat(timespec='seconds')
        batch, task, _, _ = _ecommerce_task_context(batch_id, task_id)
        attempt['mismatch_path'] = _ecommerce_archive_mismatch(batch, task, attempt)
        _ecommerce_mutate_batch(batch_id, lambda b: _ecommerce_sync_attempt(b, task_id, attempt))
        batch, task, _, _ = _ecommerce_task_context(batch_id, task_id)
        review = _ecommerce_archive_manual_review(batch, task)
        error = '；'.join(output_spec.get('errors') or [])
        _ecommerce_mutate_batch(batch_id, lambda b: (_ecommerce_review_task(b, task_id, review), _ecommerce_set_task_error(b, task_id, error, state='manual_review')))
        return False

    attempt['status'] = 'awaiting_qc'
    attempt.pop('error', None)
    _ecommerce_mutate_batch(batch_id, lambda b: (_ecommerce_set_task_state(b, task_id, 'awaiting_qc'), _ecommerce_sync_attempt(b, task_id, attempt)))
    return True


def _ecommerce_qc_task_attempt(batch_id, task_id, number):
    """QC one already generated candidate without submitting a new generation task."""
    batch, task, garment, action = _ecommerce_task_context(batch_id, task_id)
    if not task or not garment or not action or task.get('state') in ECOMMERCE_FINAL_TASK_STATES:
        return False
    if batch.get('status') in ('paused', 'cancelled'):
        return False
    attempt = next((dict(item) for item in (task.get('attempts') or []) if int(item.get('number') or 0) == number), None)
    if not attempt or attempt.get('qc') is not None:
        return False
    candidate = attempt.get('candidate_path')
    if not candidate or not os.path.isfile(candidate):
        return False

    attempt['status'] = 'qc'
    _ecommerce_mutate_batch(batch_id, lambda b: (_ecommerce_set_task_state(b, task_id, 'qc'), _ecommerce_sync_attempt(b, task_id, attempt)))
    qc = None
    qc_error = None
    for qc_try in range(3):
        try:
            batch, task, garment, action = _ecommerce_task_context(batch_id, task_id)
            qc = _ecommerce_qc_candidate(batch, garment, action, candidate)
            break
        except Exception as exc:
            qc_error = str(exc)
            if qc_try < 2:
                time.sleep(3 * (qc_try + 1))
    if qc is None:
        # 候选图已落盘；恢复时只重试质检，绝不重复生图。
        attempt['status'] = 'qc'
        attempt['error'] = f'质检服务暂不可用: {qc_error or "未知错误"}'
        _ecommerce_mutate_batch(batch_id, lambda b: (_ecommerce_sync_attempt(b, task_id, attempt), _ecommerce_set_task_error(b, task_id, attempt['error'], state='qc')))
        return False

    attempt['qc'] = qc
    attempt['status'] = 'accepted' if qc.get('passed') else 'qc_failed'
    attempt['finished_at'] = datetime.now().isoformat(timespec='seconds')
    attempt.pop('error', None)
    _ecommerce_mutate_batch(batch_id, lambda b: _ecommerce_sync_attempt(b, task_id, attempt))
    if qc.get('passed'):
        batch, task, _, _ = _ecommerce_task_context(batch_id, task_id)
        accepted = _ecommerce_archive_accepted(batch, task, candidate)
        _ecommerce_mutate_batch(batch_id, lambda b: _ecommerce_accept_task(b, task_id, accepted))
        return True

    batch, task, _, _ = _ecommerce_task_context(batch_id, task_id)
    attempt['mismatch_path'] = _ecommerce_archive_mismatch(batch, task, attempt)
    _ecommerce_mutate_batch(batch_id, lambda b: _ecommerce_sync_attempt(b, task_id, attempt))
    max_attempts = int((batch.get('settings') or {}).get('max_attempts') or 3)
    if number >= max_attempts:
        batch, task, _, _ = _ecommerce_task_context(batch_id, task_id)
        review = _ecommerce_archive_manual_review(batch, task)
        _ecommerce_mutate_batch(batch_id, lambda b: _ecommerce_review_task(b, task_id, review))
    else:
        _ecommerce_mutate_batch(batch_id, lambda b: _ecommerce_set_task_state(b, task_id, 'retry_pending'))
    return True


def _ecommerce_run_task(batch_id, task_id):
    """Single-task compatibility runner used by tests and manual recovery."""
    batch, task, _, _ = _ecommerce_task_context(batch_id, task_id)
    if not batch or not task:
        return
    max_attempts = int((batch.get('settings') or {}).get('max_attempts') or 3)
    for number in range(1, max_attempts + 1):
        _ecommerce_generate_task_attempt(batch_id, task_id, number)
        _ecommerce_qc_task_attempt(batch_id, task_id, number)
        _, latest, _, _ = _ecommerce_task_context(batch_id, task_id)
        if not latest or latest.get('state') in ECOMMERCE_FINAL_TASK_STATES:
            return
        if latest.get('state') not in {'retry_pending'}:
            return


def _ecommerce_set_task_state(batch, task_id, state):
    task = _ecommerce_find_task(batch, task_id)
    if task:
        task['state'] = state
        task['updated_at'] = datetime.now().isoformat(timespec='seconds')


def _ecommerce_set_task_error(batch, task_id, error, state='retry_pending'):
    task = _ecommerce_find_task(batch, task_id)
    if task:
        task['last_error'] = str(error or '')
        task['state'] = state


def _ecommerce_accept_task(batch, task_id, path):
    task = _ecommerce_find_task(batch, task_id)
    if task:
        task['state'] = 'accepted'
        task['accepted_path'] = path
        task['last_error'] = ''


def _ecommerce_review_task(batch, task_id, path):
    task = _ecommerce_find_task(batch, task_id)
    if task:
        task['state'] = 'manual_review'
        task['manual_review_path'] = path


def _ecommerce_verify_task_identity(batch, task, garment, action):
    if not all((batch, task, garment, action)):
        raise RuntimeError('任务身份数据不完整')
    if task.get('garment_id') != garment.get('id') or task.get('action_id') != action.get('id'):
        raise RuntimeError('任务身份校验失败：服装或目标图不匹配，已阻止提交')
    if _ecommerce_generation_mode(batch, garment) == 'garment_prompt' and action.get('garment_id') != garment.get('id'):
        raise RuntimeError('任务身份校验失败：原图与来源子文件夹不匹配，已阻止提交')
    if _ecommerce_generation_mode(batch, garment) == 'garment_prompt':
        reference_count = 1
        reference_index = None
    elif (batch.get('settings') or {}).get('precision_matching'):
        reference_index = int(action.get('garment_reference_index') if action.get('garment_reference_index') is not None else -1)
        reference_count = 1 if reference_index < 0 else 2
    else:
        reference_index = None
        reference_count = len(garment.get('images') or [])
    return {
        'batch_id': batch.get('id'), 'task_id': task.get('id'), 'garment_id': garment.get('id'),
        'action_id': action.get('id'), 'action_order': int(task.get('action_order') or 0),
        'reference_count': reference_count,
        'garment_reference_index': reference_index,
    }


def _ecommerce_run_batch_no_qc_global(batch_id):
    """跨服装滑动窗口并发；每个工作单元始终以task_id绑定素材与归档位置。"""
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return
    settings = batch.get('settings') or {}
    concurrency = max(1, min(int(settings.get('concurrency') or 10), ECOMMERCE_MAX_CONCURRENCY))
    samples_per_action = max(1, min(int(settings.get('samples_per_action') or 1), 5))

    def run_one(task_id, sample_number):
        batch_ref, task_ref, garment_ref, action_ref = _ecommerce_task_context(batch_id, task_id)
        if not task_ref or not garment_ref or not action_ref:
            return task_id, None, '任务上下文缺失'
        if batch_ref.get('status') in ('paused', 'cancelled'):
            return task_id, None, '批次已暂停/取消'
        if batch_ref.get('status') == 'cancelling' and not _ecommerce_task_has_inflight_request(task_ref):
            return task_id, None, '批次正在取消，未提交任务已停止'
        identity = _ecommerce_verify_task_identity(batch_ref, task_ref, garment_ref, action_ref)
        existing = next((a for a in task_ref.get('attempts', []) if int(a.get('number') or 0) == sample_number), None)
        attempt = dict(existing or {
            'number': sample_number, 'request_id': '', 'candidate_path': '', 'qc': None,
            'started_at': datetime.now().isoformat(timespec='seconds'), 'sample': True,
        })
        attempt['status'] = 'preparing'
        attempt['identity'] = identity
        _ecommerce_mutate_batch(batch_id, lambda b: (_ecommerce_set_task_state(b, task_id, 'preparing'), _ecommerce_sync_attempt(b, task_id, attempt)))
        candidate = attempt.get('candidate_path') if os.path.isfile(attempt.get('candidate_path') or '') else None
        error = ''
        if not candidate:
            for transport_try in range(3):
                try:
                    current_batch, current_task, current_garment, current_action = _ecommerce_task_context(batch_id, task_id)
                    _ecommerce_verify_task_identity(current_batch, current_task, current_garment, current_action)
                    candidate = _ecommerce_generate_candidate(current_batch, current_task, current_garment, current_action, current_action.get('prompt') or '', attempt)
                    break
                except InterruptedError:
                    return task_id, None, '批次已暂停/取消'
                except Exception as exc:
                    error = str(exc)
                    if _ecommerce_generation_needs_configuration(error) or isinstance(exc, PermissionError):
                        break
                    if transport_try < 2:
                        time.sleep(3 * (2 ** transport_try))
        if not candidate or not os.path.isfile(candidate):
            return task_id, None, error or '生成失败：未返回图片'
        latest_batch, latest_task, latest_garment, latest_action = _ecommerce_task_context(batch_id, task_id)
        latest_identity = _ecommerce_verify_task_identity(latest_batch, latest_task, latest_garment, latest_action)
        if latest_identity != identity:
            return task_id, None, '归档前任务身份发生变化，结果已隔离'
        archived = _ecommerce_archive_sample(latest_batch, latest_task, candidate, sample_number, samples_per_action)
        def save_archived(b):
            task_obj = _ecommerce_find_task(b, task_id)
            target = next((a for a in task_obj.get('attempts', []) if int(a.get('number') or 0) == sample_number), None) if task_obj else None
            if target:
                target.update({'candidate_path': candidate, 'archived_path': archived, 'status': 'accepted', 'finished_at': datetime.now().isoformat(timespec='seconds'), 'identity': identity})
            if task_obj:
                task_obj['state'] = 'pending'
                task_obj['last_error'] = ''
        _ecommerce_mutate_batch(batch_id, save_archived)
        return task_id, archived, None

    current = _ecommerce_batch_snapshot(batch_id)
    if current and current.get('status') not in ('paused', 'cancelled'):
        # 一个“任务×抽卡序号”就是独立远端请求。同一张源图需要3张且并发为3时，
        # 三个请求会同时进入有界窗口，不再按抽卡轮次串行等待。
        # 任务优先排列可让同一源图的多个候选尽量一起返回；task_id、sample_number
        # 和归档文件名仍是固定绑定，不会因返回顺序不同而串图。
        work_items = []
        for task_obj in sorted(current.get('tasks', []), key=lambda task: int(task.get('order') or 0)):
            if task_obj.get('state') in ECOMMERCE_FINAL_TASK_STATES:
                continue
            archived_numbers = {
                int(attempt.get('number') or 0)
                for attempt in task_obj.get('attempts', [])
                if attempt.get('archived_path')
            }
            for sample_number in range(1, samples_per_action + 1):
                if sample_number not in archived_numbers:
                    work_items.append((task_obj['id'], sample_number))

        def handle_future(future):
            try:
                task_id, _path, error = future.result()
                if error and error != '批次已暂停/取消':
                    def save_error(b, tid=task_id, message=error):
                        task_obj = _ecommerce_find_task(b, tid)
                        if task_obj:
                            task_obj['last_error'] = message
                            task_obj['state'] = 'pending'
                    _ecommerce_mutate_batch(batch_id, save_error)
            except Exception as exc:
                logger.error(f'[ecommerce global] worker异常: {exc}', exc_info=True)

        # 只保留 concurrency 个在途 Future；即使递归目录有上万张图，
        # 也不会一次创建几万个 Future 挤爆内存。
        iterator = iter(work_items)
        worker_count = min(concurrency, max(1, len(work_items)))
        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            in_flight = set()
            for _ in range(worker_count):
                item = next(iterator, None)
                if item is None:
                    break
                in_flight.add(pool.submit(run_one, *item))
            while in_flight:
                completed, in_flight = wait(in_flight, return_when=FIRST_COMPLETED)
                for future in completed:
                    handle_future(future)
                    item = next(iterator, None)
                    if item is not None:
                        in_flight.add(pool.submit(run_one, *item))

    current = _ecommerce_batch_snapshot(batch_id)
    if not current:
        return
    for task in current.get('tasks', []):
        if task.get('state') in ECOMMERCE_FINAL_TASK_STATES:
            continue
        paths = [a.get('archived_path') for a in task.get('attempts', []) if a.get('archived_path')]
        if paths:
            # 抽卡模式必须全部回填才算完成；只成功1/3或2/3时保留为
            # partial，让批次可以继续补齐，不能用“至少有一张”冒充100%。
            if len(paths) >= samples_per_action:
                _ecommerce_mutate_batch(batch_id, lambda b, tid=task['id'], path=paths[0]: _ecommerce_accept_task(b, tid, path))
            else:
                missing = samples_per_action - len(paths)
                _ecommerce_mutate_batch(batch_id, lambda b, tid=task['id'], path=paths[0], msg=f'抽卡部分回填：已完成{len(paths)}/{samples_per_action}张，还缺{missing}张': (
                    _ecommerce_set_task_error(b, tid, msg, state='partial'),
                    _ecommerce_find_task(b, tid).__setitem__('accepted_path', path),
                ))
        elif current.get('status') not in ('paused', 'cancelled'):
            _ecommerce_mutate_batch(batch_id, lambda b, tid=task['id'], msg=task.get('last_error') or '全部样本生成失败': _ecommerce_set_task_error(b, tid, msg, state='manual_review'))
    current = _ecommerce_batch_snapshot(batch_id)
    if current and current.get('status') not in ('paused', 'cancelled'):
        unfinished = [t for t in current.get('tasks', []) if t.get('state') not in ECOMMERCE_FINAL_TASK_STATES]
        final_status = 'cancelled' if current.get('status') == 'cancelling' else ('completed' if not unfinished else 'interrupted')
        _ecommerce_mutate_batch(batch_id, lambda b, status=final_status: b.update({'status': status, 'finished_at': datetime.now().isoformat(timespec='seconds') if status in {'completed', 'cancelled'} else ''}))


def _ecommerce_run_batch_no_qc(batch_id):
    """不开 AI 质检的批量运行：每张目标图生成 N 张样本，归档到独立 AI 结果目录。

    与 _ecommerce_run_batch 的区别：
      - 跳过 QC 阶段
      - 每动作生成 samples_per_action 张独立样本（抽卡），不是失败重试
      - 归档命名 <运行缩写>-AI-01.jpg（单张）/ <运行缩写>-AI-01-1.jpg（多张）
    """
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch or batch.get('status') not in ('running', 'resuming', 'cancelling'):
        return
    # 预创建缓存目录，提前暴露权限问题（避免 RunningHub API 成功后保存失败浪费额度）
    batch_cache_name = f"{_ecommerce_safe_name(batch.get('name') or '批次')}-{_ecommerce_safe_name(batch.get('id') or '')}"
    user_output_path = batch.get('output_path', '')
    # output_path 正常表示缓存基目录；兼容旧版本已经把它写成“_运行缓存”的批次，
    # 避免产生 _运行缓存/_运行缓存 的重复目录。
    cache_root = user_output_path if os.path.basename(os.path.normpath(user_output_path)) == '_运行缓存' else os.path.join(user_output_path, '_运行缓存')
    pre_create = os.path.join(cache_root, batch_cache_name)
    try:
        os.makedirs(pre_create, exist_ok=True)
        # 验证真的能写入文件（有些权限问题 makedirs 不报错但写文件会失败）
        _verify_file = os.path.join(pre_create, '.write_test')
        with open(_verify_file, 'w') as f:
            f.write('ok')
        os.remove(_verify_file)
        logger.info(f'[ecommerce no-qc] 缓存目录预创建成功: {pre_create}')
    except (PermissionError, OSError) as exc:
        logger.warning(f'[ecommerce no-qc] 用户缓存目录不可用 ({user_output_path}): {exc}，尝试 fallback 到应用目录')
        # Fallback: 使用应用自己的目录（服务器进程已知有权限）
        fallback_output = os.path.dirname(os.path.abspath(__file__))
        fallback_cache_root = os.path.join(fallback_output, '_运行缓存')
        fallback_pre_create = os.path.join(fallback_cache_root, batch_cache_name)
        try:
            os.makedirs(fallback_pre_create, exist_ok=True)
            _verify_file = os.path.join(fallback_pre_create, '.write_test')
            with open(_verify_file, 'w') as f:
                f.write('ok')
            os.remove(_verify_file)
            # 更新批次的 output_path 为 fallback 路径
            def _update_output_path(b, path=fallback_output):
                b['output_path'] = path
                b.setdefault('settings', {})['original_output_path'] = user_output_path
                b['settings']['output_path_fallback'] = True
            _ecommerce_mutate_batch(batch_id, _update_output_path)
            logger.info(f'[ecommerce no-qc] 已 fallback 缓存目录到应用目录: {fallback_pre_create}')
        except Exception as fallback_exc:
            logger.error(f'[ecommerce no-qc] fallback 缓存目录也失败: {fallback_exc}')
            err_msg = f'缓存目录权限不足且 fallback 失败。原目录: {user_output_path}，错误: {exc}。请在系统设置→隐私与安全性→文件和文件夹中授权 Python 访问下载文件夹，或把缓存目录设为其他位置。'
            def _mark_all_perm_error(b):
                for t in b.get('tasks', []):
                    if t.get('state') not in ECOMMERCE_FINAL_TASK_STATES:
                        t['last_error'] = err_msg
                        t['state'] = 'manual_review'
            _ecommerce_mutate_batch(batch_id, _mark_all_perm_error)
            _ecommerce_finalize_batch_status(batch_id)
            return
    settings = batch.get('settings') or {}
    return _ecommerce_run_batch_no_qc_global(batch_id)
    concurrency = max(1, min(int(settings.get('concurrency') or 10), 20))
    samples_per_action = max(1, min(int(settings.get('samples_per_action') or 1), 5))
    garments = sorted(batch.get('garments', []), key=lambda g: int(g.get('order') or 0))

    def _gen_one_sample(task_id, sample_number):
        batch_ref, task_ref, garment_ref, action_ref = _ecommerce_task_context(batch_id, task_id)
        if not task_ref or not action_ref:
            logger.error(f'[ecommerce no-qc] task={task_id} 缺少 task_ref 或 action_ref')
            return (task_id, None, '任务或动作配置缺失')
        if batch_ref.get('status') in ('paused', 'cancelled'):
            return (task_id, None, '批次已暂停/取消')
        if batch_ref.get('status') == 'cancelling' and not _ecommerce_task_has_inflight_request(task_ref):
            return (task_id, None, '批次正在取消，未提交任务已停止')
        attempt = {
            'number': sample_number,
            'status': 'preparing',
            'request_id': '',
            'candidate_path': '',
            'qc': None,
            'started_at': datetime.now().isoformat(timespec='seconds'),
            'sample': True,
        }

        def _mark(b, tid=task_id, a=attempt):
            _ecommerce_set_task_state(b, tid, 'preparing')
            _ecommerce_sync_attempt(b, tid, a)

        _ecommerce_mutate_batch(batch_id, _mark)
        prompt = action_ref.get('prompt') or ''
        last_err = None
        for transport_try in range(3):
            try:
                batch_ref, task_ref, garment_ref, action_ref = _ecommerce_task_context(batch_id, task_id)
                identity = _ecommerce_verify_task_identity(batch_ref, task_ref, garment_ref, action_ref)
                candidate = _ecommerce_generate_candidate(batch_ref, task_ref, garment_ref, action_ref, prompt, attempt)
                attempt['identity'] = identity
                return (task_id, candidate, None)
            except InterruptedError:
                return (task_id, None, '批次已暂停/取消')
            except PermissionError as exc:
                # 权限错误（如 macOS TCC 限制）不会因重试而好转，立即失败
                last_err = f'文件系统权限错误: {exc}'
                logger.error(f'[ecommerce no-qc] task={task_id} sample={sample_number} 权限错误，跳过重试: {exc}', exc_info=True)
                break
            except Exception as exc:
                last_err = str(exc)
                logger.error(f'[ecommerce no-qc] task={task_id} sample={sample_number} 第{transport_try+1}次生成失败: {exc}', exc_info=True)
                if _ecommerce_generation_needs_configuration(last_err):
                    break
                if transport_try < 2:
                    time.sleep(2 ** transport_try * 3)
        return (task_id, None, last_err or '生成失败')

    for garment in garments:
        current = _ecommerce_batch_snapshot(batch_id)
        if not current or current.get('status') in ('paused', 'cancelled'):
            break
        # 标记当前正在处理的服装
        _ecommerce_mutate_batch(batch_id, lambda b, g=garment: b.update({
            'current_garment_name': g.get('name') or '',
            'current_garment_index': garments.index(g) + 1,
            'garment_total': len(garments),
        }))
        garment_tasks = [
            t for t in sorted(current.get('tasks', []), key=lambda t: int(t.get('action_order') or 0))
            if t.get('garment_id') == garment.get('id') and t.get('state') not in ECOMMERCE_FINAL_TASK_STATES
        ]
        if not garment_tasks:
            continue

        for sample_number in range(1, samples_per_action + 1):
            current = _ecommerce_batch_snapshot(batch_id)
            if not current or current.get('status') in ('paused', 'cancelled'):
                break
            pending = [
                t for t in garment_tasks
                if t.get('state') not in ECOMMERCE_FINAL_TASK_STATES
            ]
            if not pending:
                break

            results = {}
            errors = {}
            with ThreadPoolExecutor(max_workers=min(concurrency, len(pending))) as pool:
                futures = [pool.submit(_gen_one_sample, t['id'], sample_number) for t in pending]
                for future in as_completed(futures):
                    try:
                        tid, candidate, err = future.result()
                        results[tid] = candidate
                        if err:
                            errors[tid] = err
                    except Exception as exc:
                        logger.error(f'[ecommerce no-qc] 第{sample_number}张生成异常: {exc}', exc_info=True)

            for t in pending:
                candidate = results.get(t['id'])
                if not candidate or not os.path.isfile(candidate):
                    # 保存具体错误到任务
                    err_msg = errors.get(t['id'], '生成失败：未返回图片')
                    def _set_err(b, tid=t['id'], msg=err_msg):
                        task_obj = _ecommerce_find_task(b, tid)
                        if task_obj:
                            task_obj['last_error'] = msg
                    _ecommerce_mutate_batch(batch_id, _set_err)
                    continue
                batch_ref, task_ref, _, _ = _ecommerce_task_context(batch_id, t['id'])
                if not task_ref:
                    continue
                try:
                    archived = _ecommerce_archive_sample(batch_ref, task_ref, candidate, sample_number, samples_per_action)

                    def _update(b, tid=t['id'], snum=sample_number, path=archived):
                        task_obj = _ecommerce_find_task(b, tid)
                        if not task_obj:
                            return
                        attempts = task_obj.setdefault('attempts', [])
                        target = next((a for a in attempts if int(a.get('number') or 0) == snum), None)
                        if not target:
                            target = {'number': snum}
                            attempts.append(target)
                        target['archived_path'] = path
                        target['status'] = 'accepted'
                        target['finished_at'] = datetime.now().isoformat(timespec='seconds')

                    _ecommerce_mutate_batch(batch_id, _update)
                except Exception as exc:
                    logger.error(f'[ecommerce no-qc] 归档异常: {exc}', exc_info=True)

        # 本套服装全部样本跑完：有归档→accepted，全失败→manual_review
        current = _ecommerce_batch_snapshot(batch_id)
        if not current:
            continue
        for t in current.get('tasks', []):
            if t.get('garment_id') != garment.get('id'):
                continue
            if t.get('state') in ECOMMERCE_FINAL_TASK_STATES:
                continue
            archived_paths = [a.get('archived_path') for a in (t.get('attempts') or []) if a.get('archived_path')]
            if archived_paths:
                def _accept(b, tid=t['id'], path=archived_paths[0]):
                    _ecommerce_accept_task(b, tid, path)
                _ecommerce_mutate_batch(batch_id, _accept)
            else:
                task_err = t.get('last_error') or '全部样本生成失败'
                def _fail(b, tid=t['id'], msg=task_err):
                    _ecommerce_set_task_error(b, tid, msg, state='manual_review')
                _ecommerce_mutate_batch(batch_id, _fail)

    current = _ecommerce_batch_snapshot(batch_id)
    if current and current.get('status') not in ('paused', 'cancelled'):
        unfinished = [t for t in current.get('tasks', []) if t.get('state') not in ECOMMERCE_FINAL_TASK_STATES]
        final_status = 'cancelled' if current.get('status') == 'cancelling' else ('completed' if not unfinished else 'interrupted')
        _ecommerce_mutate_batch(batch_id, lambda b, status=final_status: b.update({
            'status': status,
            'finished_at': datetime.now().isoformat(timespec='seconds') if status in {'completed', 'cancelled'} else '',
        }))


def _ecommerce_run_batch(batch_id):
    try:
        batch = _ecommerce_batch_snapshot(batch_id)
        if not batch or batch.get('status') not in ('running', 'resuming', 'cancelling'):
            return
        settings = batch.get('settings') or {}
        if not settings.get('qc_enabled', True):
            _ecommerce_run_batch_no_qc(batch_id)
            return
        concurrency = max(1, min(int(settings.get('concurrency') or 10), ECOMMERCE_MAX_CONCURRENCY))
        max_attempts = max(1, min(int((batch.get('settings') or {}).get('max_attempts') or 3), 3))
        garments = sorted(batch.get('garments', []), key=lambda g: int(g.get('order') or 0))
        # 严格按服装、按轮执行：整轮动作全部生成后才集中质检；失败项进入下一轮。
        for garment in garments:
            current = _ecommerce_batch_snapshot(batch_id)
            if not current or current.get('status') in ('paused', 'cancelled'):
                break
            for number in range(1, max_attempts + 1):
                current = _ecommerce_batch_snapshot(batch_id)
                if not current or current.get('status') in ('paused', 'cancelled'):
                    break
                task_ids = [
                    t['id'] for t in sorted(current.get('tasks', []), key=lambda t: int(t.get('action_order') or 0))
                    if t.get('garment_id') == garment.get('id') and t.get('state') not in ECOMMERCE_FINAL_TASK_STATES
                ]
                if not task_ids:
                    break

                # 阶段一：当前轮全部生成完成。已有候选图的任务会直接跳过生成。
                with ThreadPoolExecutor(max_workers=min(concurrency, len(task_ids))) as pool:
                    futures = [pool.submit(_ecommerce_generate_task_attempt, batch_id, task_id, number) for task_id in task_ids]
                    for future in as_completed(futures):
                        try:
                            future.result()
                        except Exception as exc:
                            logger.error(f'[ecommerce] 第{number}轮生成异常: {exc}', exc_info=True)

                current = _ecommerce_batch_snapshot(batch_id)
                if not current or current.get('status') in ('paused', 'cancelled'):
                    break
                qc_task_ids = []
                for task in sorted(current.get('tasks', []), key=lambda t: int(t.get('action_order') or 0)):
                    if task.get('garment_id') != garment.get('id') or task.get('state') in ECOMMERCE_FINAL_TASK_STATES:
                        continue
                    attempt = next((a for a in (task.get('attempts') or []) if int(a.get('number') or 0) == number), None)
                    if attempt and attempt.get('candidate_path') and attempt.get('qc') is None:
                        qc_task_ids.append(task['id'])

                # 阶段二：上一阶段的全部候选图就绪后，再统一启动质检。
                if qc_task_ids:
                    with ThreadPoolExecutor(max_workers=min(concurrency, len(qc_task_ids))) as pool:
                        futures = [pool.submit(_ecommerce_qc_task_attempt, batch_id, task_id, number) for task_id in qc_task_ids]
                        for future in as_completed(futures):
                            try:
                                future.result()
                            except Exception as exc:
                                logger.error(f'[ecommerce] 第{number}轮质检异常: {exc}', exc_info=True)

                current = _ecommerce_batch_snapshot(batch_id)
                garment_unfinished = [
                    t for t in (current.get('tasks', []) if current else [])
                    if t.get('garment_id') == garment.get('id') and t.get('state') not in ECOMMERCE_FINAL_TASK_STATES
                ]
                if not garment_unfinished:
                    break
            _ecommerce_finalize_garment_outputs(batch_id, garment.get('id'))
            current = _ecommerce_batch_snapshot(batch_id)
            garment_unfinished = [
                t for t in (current.get('tasks', []) if current else [])
                if t.get('garment_id') == garment.get('id') and t.get('state') not in ECOMMERCE_FINAL_TASK_STATES
            ]
            # 网络、配置或质检服务故障时停在当前服装，避免后续服装继续产生费用。
            if garment_unfinished:
                break
        current = _ecommerce_batch_snapshot(batch_id)
        if current and current.get('status') not in ('paused', 'cancelled'):
            unfinished = [t for t in current.get('tasks', []) if t.get('state') not in ECOMMERCE_FINAL_TASK_STATES]
            final_status = 'cancelled' if current.get('status') == 'cancelling' else ('completed' if not unfinished else 'interrupted')
            _ecommerce_mutate_batch(batch_id, lambda b, status=final_status: b.update({
                'status': status,
                'finished_at': datetime.now().isoformat(timespec='seconds') if status in {'completed', 'cancelled'} else '',
            }))
    finally:
        with ecommerce_lock:
            ecommerce_active_runners.discard(batch_id)


def _ecommerce_launch_batch(batch_id):
    with ecommerce_lock:
        if batch_id in ecommerce_active_runners:
            return False
        ecommerce_active_runners.add(batch_id)
    ecommerce_runner_executor.submit(_ecommerce_run_batch, batch_id)
    return True


def _ecommerce_resume_running_batches():
    """服务重启后只恢复原本处于运行态的批次；已暂停的批次保持暂停。"""
    with ecommerce_lock:
        ids = [b.get('id') for b in _ecommerce_load_store().get('batches', [])
               if b.get('status') in ('running', 'resuming', 'cancelling') and b.get('id')]
        # 热重载/进程重启后，旧进程标成 running 的重做项已经没有本地执行者。
        # 将它们放回 pending；regenerate 会复用已持久化的 provider taskId 查询
        # 原任务，绝不因为重启而再次付费提交。
        store = _ecommerce_load_store()
        cleaned = 0
        for rb in (store.get('rerun_batches') or []):
            recovered_orphans = 0
            for item in rb.get('items') or []:
                if item.get('status') != 'running':
                    continue
                if item.get('worker_id') == ECOMMERCE_PROCESS_ID:
                    continue
                item['status'] = 'pending'
                item['recovery_pending'] = True
                item['error'] = '应用重启：已保留平台任务，继续时只查询原任务并回填，不重复提交'
                item['worker_id'] = ''
                recovered_orphans += 1
            if recovered_orphans:
                rb['status'] = 'interrupted'
                rb['error'] = f'应用重启中断了{recovered_orphans}项本地回填，可安全继续'
                rb['finished_at'] = ''
                _ecommerce_refresh_rerun_batch_counts(rb)
                cleaned += 1
                continue
            if rb.get('status') not in {'running', 'resuming'}:
                continue
            rb_items = rb.get('items') or []
            all_done = all(
                (it.get('status') or '') in {'accepted', 'failed', 'skipped'}
                for it in rb_items
            )
            all_pending = all((it.get('status') or '') == 'pending' for it in rb_items)
            updated_at = rb.get('updated_at') or rb.get('created_at') or ''
            try:
                last_update = datetime.fromisoformat(updated_at) if updated_at else None
                stale = (all_done or all_pending) and (
                    not last_update or (datetime.now() - last_update).total_seconds() > 600
                )
            except (ValueError, TypeError):
                stale = bool(all_done or all_pending)
            if stale:
                rb['status'] = 'failed'
                rb['finished_at'] = datetime.now().isoformat(timespec='seconds')
                if not rb.get('error'):
                    rb['error'] = '批次中断（应用重启）'
                cleaned += 1
        if cleaned > 0:
            _ecommerce_save_store(store)
            logger.info(f'[startup] 恢复或清理了 {cleaned} 个中断的重做批次')
    for batch_id in ids:
        _ecommerce_launch_batch(batch_id)


@app.route('/api/ecommerce/batches/<batch_id>/action', methods=['POST'])
def ecommerce_batch_action(batch_id):
    body = request.get_json(silent=True) or {}
    action = str(body.get('action') or '').lower()
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '批次不存在'}), 404
    if action in ('start', 'resume'):
        allowed_statuses = {'draft', 'paused', 'interrupted', 'resuming'}
        if batch.get('status') not in allowed_statuses:
            if batch.get('status') in {'running'}:
                return jsonify({'ok': True, 'status': 'running', 'launched': False, 'already_running': True})
            return jsonify({'error': f"批次当前状态为“{batch.get('status') or '未知'}”，不能再次启动"}), 409
        settings = batch.get('settings') or {}
        action_count = len(((batch.get('template') or {}).get('actions') or []))
        concurrency_val = int(settings.get('concurrency') or 10)
        if action_count > 0 and concurrency_val % action_count != 0:
            aligned = max(action_count, round(concurrency_val / action_count) * action_count)
            aligned = min(aligned, ECOMMERCE_MAX_CONCURRENCY)
            def align_concurrency(b):
                b.setdefault('settings', {})['concurrency'] = aligned
            _ecommerce_mutate_batch(batch_id, align_concurrency)
        _ecommerce_mutate_batch(batch_id, lambda b: b.update({'status': 'running', 'started_at': b.get('started_at') or datetime.now().isoformat(timespec='seconds')}))
        launched = _ecommerce_launch_batch(batch_id)
        return jsonify({'ok': True, 'status': 'running', 'launched': launched})
    if action == 'pause':
        if batch.get('status') not in {'running', 'resuming'}:
            return jsonify({'error': f"批次当前状态为“{batch.get('status') or '未知'}”，不能暂停"}), 409
        _ecommerce_mutate_batch(batch_id, lambda b: b.update({'status': 'paused'}))
        return jsonify({'ok': True, 'status': 'paused'})
    if action == 'force_pause':
        # 强制重置：用于批次状态卡死（resuming/interrupted 等）时恢复
        # 直接把状态改为 paused，不取消任何任务，不丢失已生成图片
        # 同时从 active_runners 移除，让旧的运行循环退出
        with ecommerce_lock:
            ecommerce_active_runners.discard(batch_id)
        _ecommerce_mutate_batch(batch_id, lambda b: b.update({'status': 'paused'}))
        logger.info(f'[ecommerce-action] 批次 {batch_id} 已强制重置为 paused')
        return jsonify({'ok': True, 'status': 'paused', 'force_reset': True})
    if action == 'cancel':
        if batch.get('status') in {'completed', 'cancelled'}:
            return jsonify({'error': f"批次已经是“{batch.get('status')}”，不能重复取消"}), 409
        inflight = []
        def cancel_batch(b):
            nonlocal inflight
            inflight = [task.get('id') for task in b.get('tasks', []) if _ecommerce_task_has_inflight_request(task) or _ecommerce_task_has_unarchived_candidate(task)]
            b['status'] = 'cancelling' if inflight else 'cancelled'
            for task in b.get('tasks', []):
                if task.get('id') not in inflight and task.get('state') not in ECOMMERCE_FINAL_TASK_STATES:
                    task['state'] = 'cancelled'
        _ecommerce_mutate_batch(batch_id, cancel_batch)
        launched = False
        if inflight:
            launched = _ecommerce_launch_batch(batch_id)
        return jsonify({'ok': True, 'status': 'cancelling' if inflight else 'cancelled', 'inflight_tasks': len(inflight), 'launched': launched})
    return jsonify({'error': '不支持的操作'}), 400


@app.route('/api/ecommerce/batches/<batch_id>/settings', methods=['PATCH'])
def ecommerce_batch_settings(batch_id):
    """安全修改暂停批次的运行设置；关闭质检时保留并归档已有候选图。"""
    body = request.get_json(silent=True) or {}
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '批次不存在'}), 404
    if batch.get('status') not in ('paused', 'draft'):
        return jsonify({'error': '请先暂停批次，再修改质检设置'}), 409
    if 'qc_enabled' not in body:
        return jsonify({'error': '没有可修改的设置'}), 400
    qc_enabled = bool(body.get('qc_enabled'))
    recovered = 0
    # 从质检模式切到人工挑选时，已经生成出来的候选不能丢，也不能重新扣费生成。
    if not qc_enabled and (batch.get('settings') or {}).get('qc_enabled', True):
        for task in sorted(batch.get('tasks', []), key=lambda t: int(t.get('order') or 0)):
            if task.get('state') in ECOMMERCE_FINAL_TASK_STATES:
                continue
            candidate_attempt = next((
                attempt for attempt in reversed(task.get('attempts') or [])
                if attempt.get('candidate_path') and os.path.isfile(attempt.get('candidate_path'))
            ), None)
            if not candidate_attempt:
                continue
            latest = _ecommerce_batch_snapshot(batch_id)
            latest_task = _ecommerce_find_task(latest, task.get('id')) if latest else None
            if not latest_task or latest_task.get('state') in ECOMMERCE_FINAL_TASK_STATES:
                continue
            try:
                archived = _ecommerce_archive_sample(latest, latest_task, candidate_attempt['candidate_path'], 1, 1)
                def _recover(b, tid=task.get('id'), path=archived, attempt_no=candidate_attempt.get('number')):
                    current_task = _ecommerce_find_task(b, tid)
                    if not current_task:
                        return
                    current_attempt = next((a for a in current_task.get('attempts', []) if a.get('number') == attempt_no), None)
                    if current_attempt:
                        current_attempt['archived_path'] = path
                        current_attempt['status'] = 'accepted'
                    _ecommerce_accept_task(b, tid, path)
                _ecommerce_mutate_batch(batch_id, _recover)
                recovered += 1
            except Exception as exc:
                logger.warning(f'[ecommerce settings] 保留已有候选失败 task={task.get("id")}: {exc}')

    def _update_settings(b):
        b.setdefault('settings', {})['qc_enabled'] = qc_enabled
        for task in b.get('tasks', []):
            if task.get('state') not in ECOMMERCE_FINAL_TASK_STATES:
                task['state'] = 'pending'
    _ecommerce_mutate_batch(batch_id, _update_settings)
    updated = _ecommerce_batch_snapshot(batch_id)
    return jsonify({'ok': True, 'qc_enabled': qc_enabled, 'recovered_candidates': recovered, 'batch': _ecommerce_summarize_batch(updated, include_tasks=True)})


@app.route('/api/ecommerce/local-image', methods=['GET'])
def ecommerce_local_image():
    path = request.args.get('path', '')
    real, err = _ecommerce_safe_user_path(path, must_exist=True)
    if err or not os.path.isfile(real) or os.path.splitext(real)[1].lower() not in ECOMMERCE_IMAGE_EXTS:
        return jsonify({'error': err or '图片无效'}), 400
    if request.args.get('thumb') == '1':
        max_edge = max(96, min(int(request.args.get('max') or 320), 1200))
        with Image.open(real) as source:
            image = ImageOps.exif_transpose(source).convert('RGB')
            image.thumbnail((max_edge, max_edge), Image.LANCZOS)
            buffer = io.BytesIO()
            image.save(buffer, 'JPEG', quality=82, optimize=True)
            buffer.seek(0)
        response = send_file(buffer, mimetype='image/jpeg', max_age=86400)
        response.headers['Cache-Control'] = 'public, max-age=86400, immutable'
        return response
    return send_file(real, conditional=True, max_age=3600)


@app.route('/api/ecommerce/open-preview', methods=['POST'])
def ecommerce_open_preview():
    """Open validated local images in a separate macOS Preview instance."""
    body = request.get_json(silent=True) or {}
    raw_paths = body.get('paths') or []
    if not isinstance(raw_paths, list):
        return jsonify({'error': '图片列表格式无效'}), 400
    paths = []
    for raw in raw_paths[:12]:
        try:
            path = _ecommerce_resolve_rerun_reference(raw)
        except ValueError:
            continue
        if path not in paths:
            paths.append(path)
    if not paths:
        return jsonify({'error': '没有可打开的本地图片'}), 400
    try:
        subprocess.Popen(
            ['open', '-n', '-a', 'Preview', *paths],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return jsonify({'ok': True, 'count': len(paths)})
    except Exception as exc:
        logger.error(f'[ecommerce-preview] 打开系统预览失败: {exc}', exc_info=True)
        return jsonify({'error': '无法打开macOS预览'}), 500


@app.route('/api/ecommerce/crop-reference', methods=['POST'])
def ecommerce_crop_reference():
    """Create a same-aspect temporary crop for one rerun; the source is never modified."""
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    try:
        source_path = _ecommerce_resolve_rerun_reference(body.get('source'))
        x = float(body.get('x'))
        y = float(body.get('y'))
        width = float(body.get('width'))
        height = float(body.get('height'))
    except (ValueError, TypeError) as exc:
        return jsonify({'error': f'裁剪参数无效: {exc}'}), 400
    # 相同的归一化宽高表示裁剪后保持原图宽高比；不允许自由改变比例。
    if not (0 <= x < 1 and 0 <= y < 1 and 0.08 <= width <= 1 and 0.08 <= height <= 1):
        return jsonify({'error': '裁剪区域超出图片范围'}), 400
    # 归一化坐标下 width == height 即可保持原图比例（数学上等价）
    if abs(width - height) > 0.015:
        return jsonify({'error': '参考图裁剪必须保持原图比例'}), 400
    scale = min(width, height, 1 - x, 1 - y)
    if scale < 0.08:
        return jsonify({'error': '裁剪区域太小'}), 400
    batch = _ecommerce_batch_snapshot(batch_id) if batch_id else None
    cache_root = os.path.expanduser((batch or {}).get('output_path') or os.path.join(BASE_DIR, '_运行缓存'))
    target_dir = os.path.join(cache_root, '_重做临时参考图')
    os.makedirs(target_dir, exist_ok=True)
    target = os.path.join(target_dir, f"crop-{datetime.now().strftime('%Y%m%d%H%M%S')}-{gen_id('crop')}.jpg")
    with Image.open(source_path) as source:
        image = ImageOps.exif_transpose(source).convert('RGB')
        left = max(0, min(image.width - 1, round(x * image.width)))
        top = max(0, min(image.height - 1, round(y * image.height)))
        right = max(left + 1, min(image.width, round((x + scale) * image.width)))
        bottom = max(top + 1, min(image.height, round((y + scale) * image.height)))
        cropped = image.crop((left, top, right, bottom))
        cropped.save(target, 'JPEG', quality=95, optimize=True)
    return jsonify({'ok': True, 'url': _ecommerce_local_image_url(target), 'path': target})


@app.route('/api/ecommerce/open-folder', methods=['POST'])
def ecommerce_open_folder():
    """在 macOS 访达中打开指定文件夹。

    优先打开传入的 path（通常是某套服装的结果文件夹）；若该结果文件夹尚未生成，
    则回退到 garment_path（服装原始文件夹），再回退到 batch 的 output_path。
    所有路径都必须位于用户主目录下，避免打开系统目录。
    """
    body = request.get_json(silent=True) or {}
    home_dir = os.path.expanduser('~')
    app_root = os.path.dirname(os.path.abspath(__file__))

    def _safe_abs(raw):
        if not raw:
            return ''
        abs_path = os.path.abspath(os.path.expanduser(str(raw)))
        # 统一使用 _is_allowed_user_storage_path 做白名单过滤，
        # 同时允许应用根目录（_运行缓存、_成品输出 默认就在这里）
        if _is_allowed_user_storage_path(abs_path) or abs_path.startswith(app_root + os.sep) or abs_path == app_root:
            return abs_path
        return ''

    candidates = []
    preferred = _safe_abs(body.get('path'))
    if preferred:
        candidates.append(preferred)
    garment_path = _safe_abs(body.get('garment_path'))
    if garment_path:
        candidates.append(garment_path)
    output_path = _safe_abs(body.get('output_path'))
    if output_path:
        candidates.append(output_path)

    target = next((p for p in candidates if p and os.path.isdir(p)), None)
    if not target:
        # 结果文件夹尚未创建时，尝试创建一次（仅在服装目录已存在的前提下）
        if preferred and garment_path and os.path.isdir(garment_path):
            try:
                os.makedirs(preferred, exist_ok=True)
                target = preferred
            except OSError as exc:
                return jsonify({'error': f'无法创建结果文件夹: {exc}'}), 400
        if not target:
            return jsonify({'error': '文件夹尚未生成，请先运行批次'}), 400

    try:
        subprocess.run(['open', target], check=True)
        logger.info(f'[ecommerce-open-folder] 打开文件夹: {target}')
        return jsonify({'ok': True, 'path': target})
    except Exception as exc:
        logger.error(f'[ecommerce-open-folder] 异常: {exc}', exc_info=True)
        return jsonify({'error': '服务内部错误'}), 500


def _ecommerce_local_image_url(path):
    """把本地文件路径转成可被前端 <img> 加载的 local-image URL。"""
    if not path:
        return ''
    return f"/api/ecommerce/local-image?path={quote(path, safe='')}"


def _ecommerce_rerun_prompt(original_prompt, correction):
    """重做提示词二选一：本轮有输入就完整替换，否则复用原提示词。"""
    original = str(original_prompt or '').strip()
    replacement = str(correction or '').strip()
    return replacement or original


ECOMMERCE_DETAIL_REPAIR_PROMPT = """请对图1进行局部服装细节修复。图2起均为图1所穿同一件服装的权威实拍参考证据。
请直接通过视觉对比判断真实设计，不需要用户用文字描述每一套服装。
只修复图1中与参考证据不一致的服装局部，重点检查并还原领口、衣襟、盘扣、纽扣、珠扣、拉链、袖口、开叉及装饰件。
这些局部的材质、硬度观感、光泽、形状、花纹、数量、大小、间距、位置、朝向和连接方式必须以参考图为准；不得根据常见旗袍样式自行补全、简化、替换或重新设计。
如果普通全身参考与局部近景的细节表现不同，以清晰度更高、细节占画面更大的参考图为准。
除需要纠正的服装细节外，严格保持图1的人物身份、五官、发型、身材、姿势、手部、服装整体版型、背景、道具、构图、光线、色彩和分辨率不变。输出完整修复后的图片，不输出说明文字。"""


def _ecommerce_detail_repair_prompt(correction=''):
    extra = str(correction or '').strip()
    return f"{ECOMMERCE_DETAIL_REPAIR_PROMPT}\n\n本次额外修复要求：{extra}" if extra else ECOMMERCE_DETAIL_REPAIR_PROMPT


ECOMMERCE_RERUN_RH_MODELS = {
    'rhart-image-g-2/image-to-image-2k': ('rhart-image-g-2/image-to-image', '2k', 'low-cost', '¥0.10/张'),
    'rhart-image-g-2/image-to-image-4k': ('rhart-image-g-2/image-to-image', '4k', 'low-cost', '¥0.10/张'),
    'rhart-image-g-2-official/image-to-image-2k': ('rhart-image-g-2-official/image-to-image', '2k', 'official', '¥2.77/张'),
    'rhart-image-g-2-official/image-to-image-4k': ('rhart-image-g-2-official/image-to-image', '4k', 'official', '¥4.16/张'),
    # RunningHub 官方文档：官方中档使用 official endpoint + quality=medium。
    'rhart-image-g-2-medium/image-to-image-2k': ('rhart-image-g-2-official/image-to-image', '2k', 'official-medium', '¥1.13/张'),
    'rhart-image-g-2-medium/image-to-image-4k': ('rhart-image-g-2-official/image-to-image', '4k', 'official-medium', '¥1.13/张'),
    'rhart-image-n-g31-flash/image-to-image-2k': ('rhart-image-n-g31-flash/image-to-image', '2k', 'low-cost', '¥0.19/张'),
    'rhart-image-n-g31-flash/image-to-image-4k': ('rhart-image-n-g31-flash/image-to-image', '4k', 'low-cost', '¥0.30/张'),
    'rhart-image-n-g31-flash-official/image-to-image-2k': ('rhart-image-n-g31-flash-official/image-to-image', '2k', 'official', '¥0.74/张'),
    'rhart-image-n-g31-flash-official/image-to-image-4k': ('rhart-image-n-g31-flash-official/image-to-image', '4k', 'official', '¥0.99/张'),
    'rhart-image-n-pro/edit-2k': ('rhart-image-n-pro/edit', '2k', 'low-cost', '¥0.40/张'),
    'rhart-image-n-pro/edit-4k': ('rhart-image-n-pro/edit', '4k', 'low-cost', '¥0.50/张'),
    'rhart-image-n-pro-official/edit-ultra-4k': ('rhart-image-n-pro-official/edit-ultra', '4k', 'official', '¥1.50/张'),
    'seedream-v5-pro/image-to-image-1k': ('seedream-v5-pro/image-to-image', '1k', 'official', '约¥0.30/张'),
    'seedream-v5-pro/image-to-image-2k': ('seedream-v5-pro/image-to-image', '2k', 'official', '约¥0.60/张'),
}
ECOMMERCE_RERUN_HK_MODELS = {
    'fal-ai/banana/v2': ('fal-ai/banana/v2', '1k', 1024, False, '¥0.48/张'),
    'fal-ai/banana/v2/2k': ('fal-ai/banana/v2/2k', '2k', 1536, False, '¥0.48/张'),
    'fal-ai/banana/v2/4k': ('fal-ai/banana/v2/4k', '4k', 2048, False, '¥0.48/张'),
    'fal-ai/banana/v3.1/flash': ('fal-ai/banana/v3.1/flash', '1k', 1024, False, '¥0.20/张'),
    'fal-ai/banana/v3.1/flash/2k': ('fal-ai/banana/v3.1/flash/2k', '2k', 1536, False, '¥0.30/张'),
    'fal-ai/banana/v3.1/flash/4k': ('fal-ai/banana/v3.1/flash/4k', '4k', 2048, False, '¥0.48/张'),
    'gpt-image-2': ('gpt-image-2', '1k', 1024, True, '¥0.04/张'),
    'gpt-image-2/2k': ('gpt-image-2', '2k', 1536, True, '¥0.08/张'),
    'gpt-image-2/4k': ('gpt-image-2', '4k', 2048, True, '¥0.16/张'),
}
ECOMMERCE_RERUN_RATIOS = {'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9'}


def _ecommerce_apply_rerun_model(action, override):
    """Apply only server-whitelisted rerun models; client metadata is never trusted."""
    if not isinstance(override, dict) or not override:
        return dict(action)
    platform = str(override.get('platform') or '').lower()
    model_key = str(override.get('model_key') or '')
    ratio = str(override.get('aspect_ratio') or action.get('aspect_ratio') or 'auto')
    if ratio not in ECOMMERCE_RERUN_RATIOS:
        raise ValueError('不支持的生图比例')
    updated = dict(action)
    if platform == 'runninghub':
        spec = ECOMMERCE_RERUN_RH_MODELS.get(model_key)
        if not spec:
            raise ValueError('不支持的RunningHub重做模型')
        endpoint, resolution, channel, price = spec
        updated.update({
            'platform': platform, 'model_key': model_key, 'model_id': endpoint, 'endpoint': endpoint,
            'resolution': resolution, 'channel': channel, 'price': price, 'aspect_ratio': ratio,
            'quality': 'medium' if channel == 'official-medium' else ('high' if channel == 'official' else ''), 'max_images': 10,
            'is_gpt_image': False, 'poll_endpoint': '',
        })
    elif platform == 'oaihk':
        spec = ECOMMERCE_RERUN_HK_MODELS.get(model_key)
        if not spec:
            raise ValueError('不支持的HK重做模型')
        endpoint, resolution, short_edge, is_gpt, price = spec
        size = 'auto'
        if is_gpt and ratio != 'auto':
            size = (ECOMMERCE_GPT_SIZES.get(resolution) or {}).get(ratio, 'auto')
        updated.update({
            'platform': platform, 'model_key': model_key, 'model_id': endpoint, 'endpoint': endpoint,
            'resolution': resolution, 'channel': 'provider', 'price': price, 'aspect_ratio': ratio,
            'is_gpt_image': is_gpt, 'poll_endpoint': '' if is_gpt else 'fal-ai/nano-banana/requests',
            'short_edge': short_edge, 'size': size, 'quality': 'medium', 'max_images': 10,
        })
    else:
        raise ValueError('不支持的重做平台')
    return updated


def _ecommerce_resolve_rerun_reference(source):
    """Resolve a rerun UI reference URL or local path without accepting arbitrary remote URLs."""
    value = str(source or '').strip()
    if not value:
        raise ValueError('参考图为空')
    if value.startswith('/api/ecommerce/local-image'):
        path_values = parse_qs(urlparse(value).query).get('path') or []
        if not path_values:
            raise ValueError('参考图地址缺少本地路径')
        value = path_values[0]
    return _ecommerce_resolve_image_source(value)


def _ecommerce_find_rerun_source(batch, task, garment, action_order):
    """Prefer a full-resolution retained candidate/backup; use the preview only as last resort."""
    candidates = []
    cache_root = os.path.expanduser(batch.get('output_path') or '')
    if cache_root:
        garment_name = _ecommerce_safe_name(garment.get('name') or garment.get('id'), garment.get('id') or 'garment')
        backup_dir = os.path.join(cache_root, '_生成样本备份', garment_name)
        if os.path.isdir(backup_dir):
            for name in sorted(os.listdir(backup_dir), reverse=True):
                stem = os.path.splitext(name)[0]
                match = re.search(r'(?:^|-)AI-(\d+)(?:-\d+)?$', stem, re.IGNORECASE)
                if match and int(match.group(1)) == int(action_order):
                    candidates.append(os.path.join(backup_dir, name))
    for attempt in reversed(task.get('attempts') or []):
        candidates.extend([attempt.get('candidate_path'), attempt.get('archived_path')])
    candidates.extend([task.get('accepted_path'), task.get('manual_review_path')])
    candidates.append(_ecommerce_task_preview_path(batch, task))
    return next((path for path in candidates if path and os.path.isfile(path)), '')


def _ecommerce_action_model_signature(action):
    platform = str(action.get('platform') or 'unknown').lower()
    model_id = str(action.get('endpoint') or action.get('model_id') or action.get('model_key') or 'unknown')
    resolution = str(action.get('resolution') or ('4k' if str(action.get('model_key') or '').endswith('/4k') else '2k')).lower()
    channel = str(action.get('channel') or 'unspecified').lower()
    return {
        'key': f'{platform}|{model_id}|{resolution}|{channel}',
        'platform': platform,
        'model_id': model_id,
        'model_key': str(action.get('model_key') or model_id),
        'resolution': resolution.upper(),
        'channel': channel,
        'price': str(action.get('price') or ''),
        'aspect_ratio': str(action.get('aspect_ratio') or 'auto'),
    }


def _ecommerce_record_waste_scan(batch, items, garment_ids=None, scope_label='整批'):
    """同一批次重复扫描只更新一条记录，同时保留首次扫描基线。"""
    actions = (batch.get('template') or {}).get('actions') or []
    actions_by_id = {a.get('id'): a for a in actions}
    breakdown = {}
    garment_ids = set(garment_ids or [])
    scoped_tasks = [task for task in batch.get('tasks', []) if not garment_ids or task.get('garment_id') in garment_ids]
    for task in scoped_tasks:
        action = actions_by_id.get(task.get('action_id')) or next(
            (a for a in actions if int(a.get('order') or 0) == int(task.get('action_order') or 0)), {}
        )
        signature = _ecommerce_action_model_signature(task.get('result_model') or action)
        row = breakdown.setdefault(signature['key'], {**signature, 'generated': 0, 'deleted': 0})
        if task.get('state') == 'accepted' or task.get('accepted_path') or any(a.get('archived_path') for a in task.get('attempts', [])):
            row['generated'] += 1
    for item in items:
        action = actions_by_id.get(item.get('action_id')) or {}
        signature = _ecommerce_action_model_signature(item.get('model_signature') or action)
        row = breakdown.setdefault(signature['key'], {**signature, 'generated': 0, 'deleted': 0})
        row['deleted'] += max(1, int(item.get('missing_count') or 1))
    model_rows = []
    for row in breakdown.values():
        row['waste_rate'] = round((row['deleted'] / row['generated'] * 100) if row['generated'] else 0, 2)
        model_rows.append(row)
    generated = sum(row['generated'] for row in model_rows)
    deleted = sum(max(1, int(item.get('missing_count') or 1)) for item in items)
    now = datetime.now().isoformat(timespec='seconds')
    usage = batch.get('usage') or {}
    with ecommerce_lock:
        store = _ecommerce_load_store()
        records = store.setdefault('waste_scans', [])
        scope_key = f"{batch.get('id')}|{','.join(sorted(garment_ids)) if garment_ids else 'all'}"
        existing = next((r for r in records if r.get('scope_key') == scope_key), None)
        if existing is None and not garment_ids:
            # 兼容升级前只有 batch_id、没有 scope_key 的整批统计记录。
            existing = next((r for r in records if r.get('batch_id') == batch.get('id') and not r.get('scope_key')), None)
        if existing is None:
            existing = {
                'id': gen_id('waste'), 'batch_id': batch.get('id'), 'batch_name': batch.get('name'),
                'scope_key': scope_key, 'scope_label': scope_label,
                'first_scan_at': now, 'first_deleted': deleted, 'scan_count': 0,
            }
            records.append(existing)
        total_tasks = max(1, len(batch.get('tasks', [])))
        scoped_cost = float(usage.get('runninghub_billed_cny') or 0) * len(scoped_tasks) / total_tasks
        existing.update({
            'batch_name': batch.get('name'), 'last_scan_at': now, 'generated': generated,
            'current_deleted': deleted, 'waste_rate': round((deleted / generated * 100) if generated else 0, 2),
            'model_breakdown': model_rows, 'billed_cny': round(scoped_cost, 4),
            'run_code': batch.get('run_code') or '', 'scope_label': scope_label,
            'qc_enabled': bool((batch.get('settings') or {}).get('qc_enabled', True)),
        })
        existing['scan_count'] = int(existing.get('scan_count') or 0) + 1
        store['waste_scans'] = sorted(records, key=lambda r: r.get('last_scan_at') or '', reverse=True)[:100]
        _ecommerce_save_store(store)
        return dict(existing)


@app.route('/api/ecommerce/waste-stats', methods=['GET'])
def ecommerce_waste_stats():
    limit = max(1, min(int(request.args.get('limit') or 20), 100))
    with ecommerce_lock:
        records = list(_ecommerce_load_store().get('waste_scans', []))[:limit]
    return jsonify({'records': records, 'total': len(records)})


def _ecommerce_file_size(paths):
    return sum(os.path.getsize(path) for path in set(paths) if path and os.path.isfile(path))


def _ecommerce_task_preview_path(batch, task):
    garment_name = _ecommerce_safe_name(task.get('garment_name') or task.get('garment_id'))
    filename = f"AI-{int(task.get('action_order') or 0) + 1:02d}.jpg"
    return os.path.join(os.path.expanduser(batch.get('output_path') or ''), '_废片预览备份', _ecommerce_safe_name(batch.get('id') or 'batch'), garment_name, filename)


def _ecommerce_sample_identity(path_or_name):
    """解析 AI 结果文件名，返回动作编号、样本序号、类型、轮次等信息。

    命名规范（新格式）：
      - 首次单张：AI-02-01.jpg
      - 首次抽卡：AI-02-CK01.jpg、AI-02-CK02.jpg ...
      - 废片重做第N轮单张：AI-02-FPN-01.jpg
      - 废片重做第N轮抽卡：AI-02-FPN-CK01.jpg、AI-02-FPN-CK02.jpg ...
      - 标记重做：AI-02-BJ01.jpg、AI-02-BJ02.jpg ...
    旧格式兼容：
      - AI-02.jpg（旧单张）→ type=first
      - AI-02-1.jpg、AI-02-2.jpg（旧抽卡，无CK前缀，无前置0）→ type=ck
    返回 dict：
      action_order: int, 1-based 动作编号
      sample_index: int, 该类型内的序号（从1开始）
      fp_round: int, 废片重做轮次（0=首次生成）
      type: str, 'first'|'ck'|'fp'|'fp_ck'|'bj'
      is_marked_redo: bool, 是否仍处于“待标记重做”状态（文件名不能决定该状态）
      is_marked_rerun: bool, 是否为标记重做生成的候选(BJ)
      is_valid_result: bool, 是否为有效成品候选
    """
    basename = os.path.basename(str(path_or_name or ''))
    if basename.lower().endswith('.deleted'):
        basename = basename[:-len('.deleted')]
    stem = os.path.splitext(basename)[0]
    # Strip -recovered suffix (from recycle bin recovery) before identity parsing
    stem = re.sub(r'-recovered(?:-\d+)?$', '', stem, flags=re.IGNORECASE)

    # 按从最具体到最通用的顺序匹配

    # 1) 废片重做·抽卡：-FP{轮次}-CK{序号}
    collision_suffix = r'(?:-(?:\d+|[0-9a-f]{10,}))?'
    m = re.search(r'(?:^|-)AI-(\d+)-FP(\d+)-CK(\d+)' + collision_suffix + r'$', stem, re.IGNORECASE)
    if m:
        return {
            'action_order': int(m.group(1)),
            'sample_index': int(m.group(3)),
            'fp_round': int(m.group(2)),
            'type': 'fp_ck',
            'is_marked_redo': False,
            'is_marked_rerun': False,
            'is_valid_result': True,
        }

    # 2) 废片重做·单张：-FP{轮次}-{序号(两位以上)}
    m = re.search(r'(?:^|-)AI-(\d+)-FP(\d+)-(\d{2,})' + collision_suffix + r'$', stem, re.IGNORECASE)
    if m:
        return {
            'action_order': int(m.group(1)),
            'sample_index': int(m.group(3)),
            'fp_round': int(m.group(2)),
            'type': 'fp',
            'is_marked_redo': False,
            'is_marked_rerun': False,
            'is_valid_result': True,
        }

    # 3) 标记重做：-BJ{序号}
    m = re.search(r'(?:^|-)AI-(\d+)-BJ(\d+)' + collision_suffix + r'$', stem, re.IGNORECASE)
    if m:
        return {
            'action_order': int(m.group(1)),
            'sample_index': int(m.group(2)),
            'fp_round': 0,
            'type': 'bj',
            # BJ 只表示“由标记重做产生”。新图本身是正常候选；是否仍待重做
            # 由 marked_redo 台账中绑定原图的活动记录决定。
            'is_marked_redo': False,
            'is_marked_rerun': True,
            'is_valid_result': True,
        }

    # 4) 首次抽卡（新格式）：-CK{序号}
    m = re.search(r'(?:^|-)AI-(\d+)-CK(\d+)' + collision_suffix + r'$', stem, re.IGNORECASE)
    if m:
        return {
            'action_order': int(m.group(1)),
            'sample_index': int(m.group(2)),
            'fp_round': 0,
            'type': 'ck',
            'is_marked_redo': False,
            'is_marked_rerun': False,
            'is_valid_result': True,
        }

    # 5) 首次单张（新格式）：-01（带前置0，固定01）
    m = re.search(r'(?:^|-)AI-(\d+)-0(\d)' + collision_suffix + r'$', stem, re.IGNORECASE)
    if m:
        return {
            'action_order': int(m.group(1)),
            'sample_index': int(m.group(2)),
            'fp_round': 0,
            'type': 'first',
            'is_marked_redo': False,
            'is_marked_rerun': False,
            'is_valid_result': True,
        }

    # 6) 旧格式抽卡：-{1-9}（无前置0，1-9，历史兼容）
    m = re.search(r'(?:^|-)AI-(\d+)-([1-9]\d*)(?:-(?:\d+|[0-9a-f]{10,}))?$', stem, re.IGNORECASE)
    if m:
        return {
            'action_order': int(m.group(1)),
            'sample_index': int(m.group(2)),
            'fp_round': 0,
            'type': 'ck',
            'is_marked_redo': False,
            'is_marked_rerun': False,
            'is_valid_result': True,
        }

    # 7) 旧格式单张：AI-XX（无后缀，历史兼容）
    m = re.search(r'(?:^|-)AI-(\d+)$', stem, re.IGNORECASE)
    if m:
        return {
            'action_order': int(m.group(1)),
            'sample_index': 1,
            'fp_round': 0,
            'type': 'first',
            'is_marked_redo': False,
            'is_marked_rerun': False,
            'is_valid_result': True,
        }

    return None


def _ecommerce_result_identity(batch, garment, path_or_name):
    """Resolve identity from ledger first, directory manifest second, filename last."""
    path_text = str(path_or_name or '')
    result_dir = _ecommerce_sample_result_dir(batch, garment) if batch and garment else ''
    if os.path.isabs(path_text):
        real_path = os.path.realpath(os.path.expanduser(path_text))
    elif result_dir:
        real_path = os.path.realpath(os.path.join(result_dir, path_text))
    else:
        real_path = ''
    garment_id = (garment or {}).get('id') or ''

    asset = next((
        row for row in (batch or {}).get('result_assets') or []
        if row.get('garment_id') == garment_id
        and os.path.realpath(os.path.expanduser(row.get('path') or '')) == real_path
    ), None)
    if asset is None and result_dir:
        manifest_path = os.path.join(result_dir, 'asset-manifest.json')
        try:
            with open(manifest_path, 'r', encoding='utf-8') as handle:
                manifest = json.load(handle)
            if manifest.get('batch_id') == (batch or {}).get('id') and manifest.get('garment_id') == garment_id:
                asset = next((
                    row for row in manifest.get('assets') or []
                    if os.path.realpath(os.path.expanduser(row.get('path') or '')) == real_path
                ), None)
        except (OSError, ValueError, TypeError):
            asset = None
    if asset:
        kind = str(asset.get('generation_kind') or 'first')
        return {
            'action_order': int(asset.get('action_order') or 0),
            'sample_index': int(asset.get('candidate_index') or 1),
            'fp_round': int(asset.get('round') or 0),
            'type': kind,
            'is_marked_redo': False,
            'is_marked_rerun': kind == 'bj',
            'is_valid_result': True,
            'asset_id': asset.get('asset_id') or '',
            'asset_status': asset.get('status') or 'active',
            'identity_source': 'ledger' if asset in ((batch or {}).get('result_assets') or []) else 'manifest',
        }
    identity = _ecommerce_sample_identity(path_text)
    if identity:
        identity = dict(identity)
        identity['identity_source'] = 'filename'
    return identity


def _ecommerce_next_fp_round(result_dir, action_order):
    """扫描结果目录，计算某动作下一个废片重做轮次。

    已有 FP01 → 返回 2；无 FP 文件 → 返回 1。
    """
    max_round = 0
    if not result_dir or not os.path.isdir(result_dir):
        return 1
    try:
        for name in os.listdir(result_dir):
            if not os.path.isfile(os.path.join(result_dir, name)):
                continue
            identity = _ecommerce_sample_identity(name)
            if not identity:
                continue
            if identity['action_order'] != action_order:
                continue
            if identity['type'] in ('fp', 'fp_ck'):
                max_round = max(max_round, identity.get('fp_round', 0))
    except OSError:
        pass
    return max(max_round + 1, 1)


def _ecommerce_next_sample_index(result_dir, action_order, file_type, fp_round=0):
    """扫描结果目录，计算某类型下一个可用的样本序号。

    例如已有 CK01、CK02 → 返回 3；已有 BJ01、BJ03 → 返回 4（取最大值+1，保证序号递增不重复）。
    """
    max_index = 0
    if not result_dir or not os.path.isdir(result_dir):
        return 1
    try:
        for name in os.listdir(result_dir):
            if not os.path.isfile(os.path.join(result_dir, name)):
                continue
            identity = _ecommerce_sample_identity(name)
            if not identity:
                continue
            if identity['action_order'] != action_order:
                continue
            if identity['type'] != file_type:
                continue
            if file_type in ('fp', 'fp_ck') and identity.get('fp_round', 0) != fp_round:
                continue
            max_index = max(max_index, identity.get('sample_index', 0))
    except OSError:
        pass
    return max(max_index + 1, 1)


def _ecommerce_create_light_preview(source_path, target_path):
    if not source_path or not os.path.isfile(source_path):
        return ''
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    with Image.open(source_path) as source_image:
        preview = ImageOps.exif_transpose(source_image).convert('RGB')
        if max(preview.size) > 1800:
            scale = 1800 / max(preview.size)
            preview = preview.resize(
                (max(1, int(preview.width * scale)), max(1, int(preview.height * scale))),
                Image.LANCZOS,
            )
        preview.save(target_path, 'JPEG', quality=86, optimize=True)
    return target_path


def _ecommerce_deleted_preview_path(batch, garment, action_order, original_path):
    cache_root = os.path.expanduser(batch.get('output_path') or '')
    garment_name = _ecommerce_safe_name(garment.get('name') or garment.get('id'))
    source_path = os.path.realpath(original_path)
    if not os.path.isfile(source_path) and os.path.isfile(source_path + '.deleted'):
        source_path += '.deleted'
    fingerprint = os.path.realpath(original_path)
    try:
        stat = os.stat(source_path)
        fingerprint += f'|{stat.st_size}|{stat.st_mtime_ns}'
    except OSError:
        pass
    # Include the content version, not only the filename. A later rerun can reuse
    # the same output name and must not inherit an older deletion's preview.
    digest = hashlib.sha256(fingerprint.encode('utf-8')).hexdigest()[:12]
    filename = f"AI-{int(action_order):02d}-deleted-{digest}.jpg"
    return os.path.join(
        cache_root, '_废片预览备份', _ecommerce_safe_name(batch.get('id') or 'batch'),
        garment_name, filename,
    )


def _ecommerce_active_deleted_samples(batch, garment_id=None, action_order=None):
    active = []
    for record in batch.get('deleted_samples') or []:
        if record.get('status') not in {'deleted', 'pending'}:
            continue
        if garment_id is not None and record.get('garment_id') != garment_id:
            continue
        if action_order is not None and int(record.get('action_order') or 0) != int(action_order):
            continue
        # Soft-deleted records (file intentionally kept in source folder) are
        # always active — the user marked them for deletion and they await
        # true removal at redo-submit time.
        if record.get('soft_delete'):
            active.append(record)
            continue
        original_path = os.path.realpath(os.path.expanduser(record.get('original_path') or ''))
        # Hard-deleted records are active only if the file is truly gone.
        # The user may restore a file manually from Trash/Finder; in that case
        # it is no longer an active waste item even if the old ledger row remains.
        if original_path and os.path.isfile(original_path):
            continue
        active.append(record)
    return active


def _ecommerce_auto_resolve_stale_deletions(batch_id, deletion_ids):
    """Mark deletion records as auto-resolved when samples have been regenerated.

    Called during scan-deleted for actions whose file system already has enough
    samples.  Without this, stale ledger rows would keep reappearing as false
    positives on every subsequent scan.
    """
    if not deletion_ids:
        return
    id_set = {str(d) for d in deletion_ids}

    def resolve(stored_batch):
        for row in stored_batch.get('deleted_samples') or []:
            if str(row.get('id') or '') in id_set and row.get('status') in {'deleted', 'pending'}:
                row['status'] = 'auto_resolved'
                row['resolved_at'] = datetime.now().isoformat(timespec='seconds')

    _ecommerce_mutate_batch(batch_id, resolve)


def _ecommerce_remove_stale_marks(batch_id, mark_ids):
    """Remove marked_redo entries whose target image no longer exists.

    Called from the comparison view when an action already has enough samples
    on disk, meaning the marked image was deleted and regenerated.
    """
    if not mark_ids:
        return
    id_set = {str(mid) for mid in mark_ids if mid}

    def remove_marks(stored_batch):
        stored_batch['marked_redo'] = [
            mark for mark in (stored_batch.get('marked_redo') or [])
            if str(mark.get('id') or '') not in id_set
        ]

    _ecommerce_mutate_batch(batch_id, remove_marks)


def _ecommerce_record_deleted_sample(batch_id, garment, original_path, preview_path='', recycle_path='', soft_delete=False, inferred_from_archive=False):
    identity = _ecommerce_result_identity(_ecommerce_batch_snapshot(batch_id), garment, original_path)
    if not identity:
        return None
    original_real = os.path.realpath(os.path.expanduser(original_path))
    now = datetime.now().isoformat(timespec='seconds')

    def store_deleted(batch):
        task = next((
            item for item in batch.get('tasks') or []
            if item.get('garment_id') == garment.get('id')
            and int(item.get('action_order') or 0) + 1 == identity['action_order']
        ), None)
        records = batch.setdefault('deleted_samples', [])
        existing = next((
            row for row in records
            if row.get('garment_id') == garment.get('id')
            and os.path.realpath(os.path.expanduser(row.get('original_path') or '')) == original_real
            and row.get('status') in {'deleted', 'pending'}
        ), None)
        payload = {
            'garment_id': garment.get('id'),
            'garment_name': garment.get('name') or garment.get('id'),
            'action_order': identity['action_order'],
            'sample_index': identity['sample_index'],
            'original_path': original_real,
            'original_name': os.path.basename(original_real),
            'preview_path': preview_path or (_ecommerce_task_preview_path(batch, task) if task else ''),
            'deleted_at': now,
            'status': 'deleted',
            'soft_delete': bool(soft_delete),
            'model_signature': (task or {}).get('result_model') or {},
            'inferred_from_archive': bool(inferred_from_archive),
        }
        if recycle_path:
            payload['recycle_path'] = os.path.realpath(os.path.expanduser(recycle_path))
        if existing:
            existing.update(payload)
            return existing
        payload['id'] = gen_id('ecdel')
        records.append(payload)
        return payload

    return _ecommerce_mutate_batch(batch_id, store_deleted)


def _ecommerce_deleted_recycle_path(batch, garment, original_path):
    """Return a hidden, same-volume recycle path outside the visible result folder.

    Keeping the recycle file on the same volume makes delete/restore atomic even
    for large 4K images on external SSDs.  The visible product folder therefore
    really loses one image, while the app can still restore an accidental delete.
    """
    result_dir = _ecommerce_sample_result_dir(batch, garment)
    if not result_dir:
        return ''
    recycle_root = os.path.join(
        os.path.dirname(os.path.realpath(os.path.expanduser(result_dir))),
        '.样片工厂废片回收站',
        _ecommerce_safe_name(batch.get('id') or 'batch'),
        _ecommerce_safe_name(garment.get('name') or garment.get('id') or 'garment'),
    )
    basename = os.path.basename(original_path)
    stem, ext = os.path.splitext(basename)
    return os.path.join(recycle_root, f'{stem}-{uuid.uuid4().hex[:12]}{ext}')


def _ecommerce_find_deleted_restore_source(batch, garment, record, original_path):
    """Find the best surviving copy for a deleted result from old and new batches.

    Recycle files are exact and disposable. Candidate and backup files are
    durable recovery sources, so callers must copy rather than move them. The
    lightweight preview is intentionally last because it may be resized.
    """
    recycle_path = os.path.realpath(os.path.expanduser(record.get('recycle_path') or ''))
    legacy_deleted = original_path + '.deleted'
    for source, source_kind in (
        (recycle_path, 'recycle'),
        (legacy_deleted, 'legacy_deleted'),
    ):
        if source and os.path.isfile(source):
            return source, source_kind, True

    action_order = int(record.get('action_order') or 0)
    task = next((
        item for item in batch.get('tasks') or []
        if item.get('garment_id') == garment.get('id')
        and int(item.get('action_order') or 0) + 1 == action_order
    ), None)
    if task:
        for attempt in reversed(task.get('attempts') or []):
            if not attempt.get('rerun'):
                continue
            for candidate_key in ('candidate_path', 'archived_path'):
                candidate = os.path.realpath(os.path.expanduser(attempt.get(candidate_key) or ''))
                if candidate and candidate != original_path and os.path.isfile(candidate):
                    return candidate, 'rerun_candidate', False

    # A newer deletion row can point at the same filename as an older replaced
    # row. Preserve that exact relationship when its retained candidate exists.
    for historical in reversed(batch.get('deleted_samples') or []):
        historical_original = os.path.realpath(os.path.expanduser(historical.get('original_path') or ''))
        if historical_original != original_path:
            continue
        retained = list(historical.get('replacement_candidates') or [])
        retained.append(historical.get('replacement_path') or '')
        for candidate_value in reversed(retained):
            candidate = os.path.realpath(os.path.expanduser(candidate_value or ''))
            if candidate and candidate != original_path and os.path.isfile(candidate):
                return candidate, 'replacement_candidate', False

    cache_root = os.path.expanduser(batch.get('output_path') or '')
    garment_name = _ecommerce_safe_name(
        garment.get('name') or garment.get('id'), garment.get('id') or 'garment',
    )
    backup_dir = os.path.join(cache_root, '_生成样本备份', garment_name) if cache_root else ''
    backup_candidates = []
    if backup_dir and os.path.isdir(backup_dir):
        try:
            for name in os.listdir(backup_dir):
                path = os.path.realpath(os.path.join(backup_dir, name))
                identity = _ecommerce_sample_identity(name)
                if (
                    os.path.isfile(path) and identity
                    and identity['action_order'] == action_order
                ):
                    backup_candidates.append(path)
        except OSError:
            backup_candidates = []
    if backup_candidates:
        backup_candidates.sort(key=lambda path: os.path.getmtime(path), reverse=True)
        return backup_candidates[0], 'generation_backup', False

    preview_path = os.path.realpath(os.path.expanduser(record.get('preview_path') or ''))
    if preview_path and os.path.isfile(preview_path):
        return preview_path, 'preview', False
    return '', '', False


def _ecommerce_restore_deleted_file(source, destination, move_source=False, preview_source=False):
    """Restore atomically while retaining durable backups and valid extensions."""
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    if move_source:
        os.rename(source, destination)
        return
    stem, ext = os.path.splitext(destination)
    temp_path = f'{stem}.restore-{uuid.uuid4().hex[:10]}{ext or ".png"}'
    try:
        if preview_source:
            with Image.open(source) as source_image:
                restored = ImageOps.exif_transpose(source_image)
                if (ext or '').lower() in {'.jpg', '.jpeg'}:
                    restored = restored.convert('RGB')
                restored.save(temp_path)
        else:
            shutil.copy2(source, temp_path)
        os.replace(temp_path, destination)
    finally:
        if os.path.isfile(temp_path):
            os.remove(temp_path)


def _ecommerce_infer_historical_deletions(batch, garment, result_path, samples_per_action=1):
    """Backfill deletion rows for outputs removed before the ledger existed.

    Successful archive paths are durable identities in this workflow: reruns are
    saved beside old results rather than replacing them. Therefore an archived
    path that used to belong to this exact result folder and is now absent can be
    treated as a user-deleted sample. Paths already seen by the ledger are never
    inferred again, including after a successful replacement.

    Another file for the same action does not prove that this exact archived
    sample was replaced. Only an explicitly linked rerun or a real restore may
    settle its deletion record.
    """
    result_real = os.path.realpath(os.path.expanduser(result_path or ''))
    if not result_real or not os.path.isdir(result_real):
        return []
    garment_id = garment.get('id')
    known_paths = {
        os.path.realpath(os.path.expanduser(row.get('original_path') or ''))
        for row in batch.get('deleted_samples') or []
        if row.get('garment_id') == garment_id and row.get('original_path')
    }
    candidates = {}
    for task in batch.get('tasks') or []:
        if task.get('garment_id') != garment_id:
            continue
        task_paths = [task.get('accepted_path'), task.get('manual_review_path')]
        task_paths.extend(
            attempt.get('archived_path')
            for attempt in task.get('attempts') or []
            if attempt.get('archived_path')
        )
        for path in task_paths:
            real = os.path.realpath(os.path.expanduser(path or ''))
            if (
                not real or real in known_paths or real in candidates
                or os.path.dirname(real) != result_real
                or os.path.isfile(real)
            ):
                continue
            identity = _ecommerce_result_identity(batch, garment, real)
            if not identity:
                continue
            candidates[real] = task
    inferred = []
    for original_path, task in candidates.items():
        preview_path = _ecommerce_task_preview_path(batch, task)
        record = _ecommerce_record_deleted_sample(
            batch.get('id'), garment, original_path,
            preview_path if os.path.isfile(preview_path) else '',
            inferred_from_archive=True,
        )
        if record:
            inferred.append(record)
    return inferred


def _ecommerce_group_compare_payload(batch, garment, show_deleted=False):
    """构建逐套验片数据。

    右侧只读取成品目录中**实际存在**的图片文件：
    - 正常图片 → 正常显示
    - 软删除但仍在原目录中的图片 → 标红显示"已删除"（用户尚未递交重做，可取消）
    - 已移到回收站的文件（硬删除或已递交重做的软删除）→ 默认不显示，
      避免新旧图片混杂；用户需要恢复时可通过 show_deleted=True 查看。

    删除和标记都精确绑定到具体图片；同动作的另一张候选不能自动结清。
    明确绑定的重做结果会在生成成功时结清，恢复操作会在文件写回后结清。
    """
    generation_mode = _ecommerce_generation_mode(batch, garment)
    if generation_mode in {'target_only', 'garment_prompt'}:
        references = [
            ref for ref in (
                _ecommerce_target_reference(action)
                for action in _ecommerce_actions_for_garment(batch, garment)
            ) if ref
        ]
        if generation_mode == 'garment_prompt':
            for reference in references:
                reference['role'] = 'source_garment'
    else:
        references = [
            {'path': path, 'url': _ecommerce_local_image_url(path), 'name': os.path.basename(path), 'role': 'garment'}
            for path in list(garment.get('images') or [])
            if path and os.path.isfile(path)
        ]
    # 新标记精确绑定具体图片；旧数据没有 result_path 时才按动作兼容。
    marked_redo_actions = set()
    marked_redo_paths = set()
    marked_redo_by_path = {}
    garment_id = garment.get('id')
    for mark in (batch.get('marked_redo') or []):
        if mark.get('garment_id') == garment_id:
            try:
                if mark.get('result_path'):
                    real = os.path.realpath(os.path.expanduser(mark.get('result_path') or ''))
                    marked_redo_paths.add(real)
                    marked_redo_by_path[real] = mark
                else:
                    marked_redo_actions.add(int(mark.get('action_order') or 0))
            except (ValueError, TypeError):
                pass
    # Build a map of soft-deleted paths for this garment. Soft-deleted files
    # are still on disk; the comparison view shows them from the source file
    # directly (marked red + "已删除") rather than from a separate preview.
    soft_deleted_by_path = {}
    for record in batch.get('deleted_samples') or []:
        if (
            record.get('garment_id') == garment_id
            and record.get('status') in {'deleted', 'pending'}
            and record.get('soft_delete')
            and record.get('original_path')
        ):
            soft_deleted_by_path[
                os.path.realpath(os.path.expanduser(record.get('original_path')))
            ] = record
    tasks = sorted(
        [task for task in batch.get('tasks', []) if task.get('garment_id') == garment.get('id')],
        key=lambda task: int(task.get('action_order') or 0),
    )
    results = []
    for task in tasks:
        current_paths = []
        seen_paths = set()
        for attempt in reversed(task.get('attempts') or []):
            path = attempt.get('archived_path')
            if path and os.path.isfile(path):
                real = os.path.realpath(path)
                if real not in seen_paths:
                    seen_paths.add(real)
                    identity = _ecommerce_result_identity(batch, garment, path)
                    current_paths.append((path, identity))
        for path in (task.get('accepted_path'), task.get('manual_review_path')):
            if path and os.path.isfile(path):
                real = os.path.realpath(path)
                if real not in seen_paths:
                    seen_paths.add(real)
                    identity = _ecommerce_result_identity(batch, garment, path)
                    current_paths.append((path, identity))
        action_order = int(task.get('action_order') or 0) + 1
        result_dir = _ecommerce_sample_result_dir(batch, garment)
        if result_dir and os.path.isdir(result_dir):
            try:
                for name in sorted(os.listdir(result_dir)):
                    if not os.path.isfile(os.path.join(result_dir, name)):
                        continue
                    stem, ext = os.path.splitext(name)
                    if ext.lower() not in ECOMMERCE_IMAGE_EXTS:
                        continue
                    if stem.endswith('.deleted'):
                        continue
                    identity = _ecommerce_result_identity(batch, garment, os.path.join(result_dir, name))
                    if identity and identity['action_order'] == action_order:
                        full = os.path.realpath(os.path.join(result_dir, name))
                        if full not in seen_paths:
                            seen_paths.add(full)
                            # 把identity信息附加到路径元组，后面构建result_entry时使用
                            current_paths.append((os.path.join(result_dir, name), identity))
            except OSError:
                pass
        if current_paths:
            for sample_index, (path, path_identity) in enumerate(current_paths, 1):
                path_real = os.path.realpath(os.path.expanduser(path))
                marked_record = marked_redo_by_path.get(path_real) or {}
                # BJ 只记录生成来源。新生成图是有效候选，不能因为文件名而永久处于待重做状态。
                is_bj_file = bool(path_identity and path_identity.get('is_marked_rerun'))
                is_marked = action_order in marked_redo_actions or path_real in marked_redo_paths
                soft_del_record = soft_deleted_by_path.get(path_real) or {}
                is_soft_deleted = bool(soft_del_record)
                result_entry = {
                    'task_id': task.get('id'),
                    'action_order': action_order,
                    'action_name': task.get('action_name') or f'目标图{action_order}',
                    'sample_index': sample_index,
                    'path': path,
                    'url': _ecommerce_local_image_url(path),
                    'deleted': is_soft_deleted,
                    'marked_redo': is_marked,
                    'mark_id': marked_record.get('id') or '',
                    'source': 'final_output',
                    'model_signature': (task.get('result_model') or {}),
                    'gen_type': path_identity.get('type', 'first') if path_identity else 'first',
                    'fp_round': path_identity.get('fp_round', 0) if path_identity else 0,
                }
                if is_soft_deleted:
                    result_entry['deletion_id'] = soft_del_record.get('id') or ''
                    result_entry['original_path'] = soft_del_record.get('original_path') or ''
                    result_entry['soft_delete'] = True
                if is_bj_file:
                    result_entry['from_marked_redo'] = True
                results.append(result_entry)
        # 默认不显示已移到回收站的删除预览，避免新旧图片混杂。
        # 只有当 show_deleted=True 时才加载回收站预览（用于恢复误删）。
        deleted_previews = []
        if show_deleted:
            deleted_records = _ecommerce_active_deleted_samples(batch, garment_id, action_order)
            for record in deleted_records:
                # Soft-deleted files are still on disk and already shown in the
                # final_output scan above; skip them here to avoid duplicates.
                if record.get('soft_delete'):
                    continue
                # After redo-submit, the file is moved to recycle_path.
                # Try preview_path first (old backup), then recycle_path.
                preview_path = record.get('preview_path') or ''
                if preview_path and os.path.isfile(preview_path):
                    deleted_previews.append((record, preview_path))
                elif record.get('recycle_path') and os.path.isfile(record.get('recycle_path')):
                    deleted_previews.append((record, record['recycle_path']))
            # 兜底预览也只在 show_deleted 时显示
            if not current_paths and not deleted_previews:
                preview_path = _ecommerce_task_preview_path(batch, task)
                if os.path.isfile(preview_path):
                    deleted_previews.append(({}, preview_path))
        for deleted_index, (record, preview_path) in enumerate(deleted_previews, 1):
            original_real = os.path.realpath(os.path.expanduser(record.get('original_path') or ''))
            marked_record = marked_redo_by_path.get(original_real) or {}
            deleted_is_marked = action_order in marked_redo_actions or original_real in marked_redo_paths
            has_recycle = bool(record.get('recycle_path') and os.path.isfile(record.get('recycle_path')))
            results.append({
                'task_id': task.get('id'),
                'action_order': action_order,
                'action_name': task.get('action_name') or f'目标图{action_order}',
                'sample_index': int(record.get('sample_index') or deleted_index),
                'path': preview_path,
                'url': _ecommerce_local_image_url(preview_path),
                'deleted': True,
                'recoverable': has_recycle,
                'recycle_path': record.get('recycle_path') or '',
                'marked_redo': deleted_is_marked,
                'mark_id': marked_record.get('id') or '',
                'source': 'deleted_preview',
                'model_signature': (task.get('result_model') or {}),
                'deletion_id': record.get('id') or '',
                'original_path': record.get('original_path') or '',
            })
    stored_final = ((batch.get('final_selections') or {}).get(garment_id) or {})
    live_results_by_action = {}
    for result in results:
        if result.get('deleted'):
            continue
        live_results_by_action.setdefault(int(result.get('action_order') or 0), []).append(result)
    for action_order, action_results in live_results_by_action.items():
        selected_path = os.path.realpath(os.path.expanduser(stored_final.get(str(action_order)) or ''))
        if selected_path and not any(
            os.path.realpath(os.path.expanduser(row.get('path') or '')) == selected_path
            for row in action_results
        ):
            selected_path = ''
        auto_selected = not selected_path and len(action_results) == 1
        if auto_selected:
            selected_path = os.path.realpath(os.path.expanduser(action_results[0].get('path') or ''))
        for row in action_results:
            row_real = os.path.realpath(os.path.expanduser(row.get('path') or ''))
            row['final_selected'] = bool(selected_path and row_real == selected_path)
            row['final_selection_auto'] = bool(auto_selected and row['final_selected'])
    actions = list(_ecommerce_actions_for_garment(batch, garment))
    action_groups = []
    for action in actions:
        action_order = int(action.get('order') or 0) + 1
        action_results = [row for row in results if int(row.get('action_order') or 0) == action_order]
        reference = _ecommerce_target_reference(action)
        if reference:
            reference = dict(reference)
            reference['action_order'] = action_order
            reference['role'] = 'source_image' if generation_mode == 'garment_prompt' else 'target_action'
        action_groups.append({
            'action_order': action_order,
            'action_code': f'A{action_order:02d}',
            'action_id': action.get('id') or '',
            'action_name': action.get('name') or f'目标图{action_order}',
            'reference': reference or {},
            'results': action_results,
            'original_count': len(action_results),
            'kept_count': len([row for row in action_results if not row.get('deleted') and not row.get('marked_redo')]),
            'deleted_count': len([row for row in action_results if row.get('deleted')]),
            'marked_count': len([row for row in action_results if row.get('marked_redo')]),
        })
    return {
        'batch_id': batch.get('id'),
        'garment_id': garment.get('id'),
        'garment_name': garment.get('name') or garment.get('id') or '未命名',
        'garment_path': garment.get('path') or '',
        'result_path': _ecommerce_sample_result_dir(batch, garment),
        'generation_mode': generation_mode,
        'references': references,
        'results': results,
        'action_groups': action_groups,
        'action_count': len(actions),
        'confirmed': garment.get('id') in (batch.get('confirmed_groups') or {}),
    }


def _ecommerce_final_candidates(batch, garment):
    """按动作编号读取真实可导出候选（排除删除和当前台账标记）。"""
    result_dir = _ecommerce_sample_result_dir(batch, garment)
    grouped = {}
    if not result_dir or not os.path.isdir(result_dir):
        return grouped
    # Build set of soft-deleted paths for this garment so they can be excluded.
    soft_deleted_paths = set()
    garment_id = garment.get('id')
    marked_paths = set()
    marked_actions = set()
    for mark in batch.get('marked_redo') or []:
        if mark.get('garment_id') != garment_id:
            continue
        if mark.get('result_path'):
            marked_paths.add(os.path.realpath(os.path.expanduser(mark.get('result_path') or '')))
        else:
            marked_actions.add(int(mark.get('action_order') or 0))
    for record in batch.get('deleted_samples') or []:
        if record.get('garment_id') != garment_id:
            continue
        if record.get('status') not in {'deleted', 'pending'}:
            continue
        if not record.get('soft_delete'):
            continue
        original = os.path.realpath(os.path.expanduser(record.get('original_path') or ''))
        if original:
            soft_deleted_paths.add(original)
    try:
        names = sorted(os.listdir(result_dir))
    except OSError:
        return grouped
    for name in names:
        path = os.path.realpath(os.path.join(result_dir, name))
        if not os.path.isfile(path) or name.lower().endswith('.deleted'):
            continue
        if path in soft_deleted_paths:
            continue
        identity = _ecommerce_result_identity(batch, garment, path)
        if not identity:
            continue
        if path in marked_paths or identity['action_order'] in marked_actions:
            continue
        # BJ只是生成来源，返回后是有效候选。
        if not identity.get('is_valid_result', False):
            continue
        grouped.setdefault(identity['action_order'], []).append(path)
    return grouped


def _ecommerce_final_export_status(batch):
    confirmed_groups = batch.get('confirmed_groups') or {}
    garment_rows = []
    total_actions = complete_actions = missing_actions = candidate_count = 0
    for garment in sorted(batch.get('garments') or [], key=lambda row: int(row.get('order') or 0)):
        garment_id = garment.get('id')
        candidates = _ecommerce_final_candidates(batch, garment)
        action_rows = []
        for action in _ecommerce_actions_for_garment(batch, garment):
            action_order = int(action.get('order') or 0) + 1
            options = candidates.get(action_order) or []
            if not options:
                state = 'missing'
                missing_actions += 1
            else:
                state = 'complete'
                complete_actions += 1
            total_actions += 1
            candidate_count += len(options)
            action_rows.append({
                'action_order': action_order,
                'action_name': action.get('name') or f'目标图{action_order}',
                'candidate_count': len(options),
                'candidate_paths': options,
                'state': state,
            })
        garment_rows.append({
            'garment_id': garment_id,
            'garment_name': garment.get('name') or garment_id,
            'relative_path': garment.get('relative_path') or garment.get('name') or garment_id,
            'actions': action_rows,
            'confirmed': garment_id in confirmed_groups,
            'confirmed_at': (confirmed_groups.get(garment_id) or {}).get('confirmed_at') or '',
        })
    return {
        'batch_id': batch.get('id'),
        'batch_name': batch.get('name') or batch.get('id'),
        'ready': total_actions > 0 and complete_actions == total_actions,
        'total_actions': total_actions,
        'complete_actions': complete_actions,
        'selected_actions': complete_actions,
        'missing_actions': missing_actions,
        'ambiguous_actions': 0,
        'candidate_count': candidate_count,
        'extra_candidates': max(0, candidate_count - complete_actions),
        'garments': garment_rows,
        'confirmed_groups': confirmed_groups,
        'confirmed_count': len(confirmed_groups),
    }


def _ecommerce_ensure_task_preview(batch, task):
    preview_path = _ecommerce_task_preview_path(batch, task)
    if os.path.isfile(preview_path):
        return preview_path
    source = next((a.get('candidate_path') for a in reversed(task.get('attempts', [])) if os.path.isfile(a.get('candidate_path') or '')), '')
    if not source:
        source = next((p for p in [task.get('accepted_path')] + [a.get('archived_path') for a in task.get('attempts', [])] if os.path.isfile(p or '')), '')
    if not source:
        return ''
    os.makedirs(os.path.dirname(preview_path), exist_ok=True)
    with Image.open(source) as source_image:
        preview = ImageOps.exif_transpose(source_image).convert('RGB')
        if max(preview.size) > 1800:
            scale = 1800 / max(preview.size)
            preview = preview.resize((max(1, int(preview.width * scale)), max(1, int(preview.height * scale))), Image.LANCZOS)
        preview.save(preview_path, 'JPEG', quality=86, optimize=True)
    return preview_path


def _ecommerce_cache_inventory():
    with ecommerce_lock:
        batches = list(_ecommerce_load_store().get('batches', []))
    candidates, backups, previews, qc_files = set(), set(), set(), set()
    active = 0
    for batch in batches:
        if batch.get('status') in ('running', 'resuming', 'paused'):
            active += 1
        for task in batch.get('tasks', []):
            for attempt in task.get('attempts', []):
                if attempt.get('candidate_path'): candidates.add(attempt['candidate_path'])
                if attempt.get('archived_path') and '_生成样本备份' in attempt['archived_path']: backups.add(attempt['archived_path'])
            if task.get('accepted_path') and '_生成样本备份' in task['accepted_path']: backups.add(task['accepted_path'])
            preview = _ecommerce_task_preview_path(batch, task)
            if os.path.isfile(preview): previews.add(preview)
        for garment in batch.get('garments', []):
            for path in (garment.get('qc_assets') or {}).values():
                if path: qc_files.add(path)
    return {
        'candidate_bytes': _ecommerce_file_size(candidates), 'backup_bytes': _ecommerce_file_size(backups),
        'preview_bytes': _ecommerce_file_size(previews), 'qc_bytes': _ecommerce_file_size(qc_files),
        'candidate_files': len([p for p in candidates if os.path.isfile(p)]),
        'backup_files': len([p for p in backups if os.path.isfile(p)]),
        'preview_files': len(previews), 'active_batches': active,
    }


@app.route('/api/ecommerce/cache-status', methods=['GET'])
def ecommerce_cache_status():
    inventory = _ecommerce_cache_inventory()
    inventory['total_bytes'] = sum(inventory[k] for k in ('candidate_bytes', 'backup_bytes', 'preview_bytes', 'qc_bytes'))
    return jsonify(inventory)


@app.route('/api/ecommerce/cache-clean', methods=['POST'])
def ecommerce_cache_clean():
    body = request.get_json(silent=True) or {}
    mode = str(body.get('mode') or 'safe')
    batch_id = str(body.get('batch_id') or '')
    with ecommerce_lock:
        batches = list(_ecommerce_load_store().get('batches', []))
    targets = batches if mode == 'safe' else [b for b in batches if b.get('id') == batch_id]
    if mode == 'batch_all' and not targets:
        return jsonify({'error': '请选择要删除本地文件的批次'}), 400
    if any(b.get('status') in ('running', 'resuming') for b in targets):
        return jsonify({'error': '运行中的批次不能清理'}), 409
    all_references = {}
    for batch in batches:
        for task in batch.get('tasks', []):
            for path in [task.get('accepted_path')] + [a.get('archived_path') for a in task.get('attempts', [])]:
                if path: all_references.setdefault(path, set()).add(batch.get('id'))
    delete_paths = set()
    previews_created = 0
    for batch in targets:
        if mode == 'safe' and batch.get('status') not in ('completed', 'interrupted', 'cancelled'):
            continue
        for task in batch.get('tasks', []):
            try:
                if _ecommerce_ensure_task_preview(batch, task): previews_created += 1
            except Exception as exc:
                logger.warning(f'[cache-clean] 创建预览失败 task={task.get("id")}: {exc}')
                continue
            for attempt in task.get('attempts', []):
                candidate = attempt.get('candidate_path')
                if candidate and candidate != task.get('accepted_path'): delete_paths.add(candidate)
            if mode == 'batch_all':
                delete_paths.add(_ecommerce_task_preview_path(batch, task))
                for path in [task.get('accepted_path')] + [a.get('archived_path') for a in task.get('attempts', [])]:
                    if path and all_references.get(path, {batch.get('id')}) <= {batch.get('id')}:
                        delete_paths.add(path)
        if mode == 'safe':
            for garment in batch.get('garments', []):
                delete_paths.update((garment.get('qc_assets') or {}).values())
    before = _ecommerce_file_size(delete_paths)
    deleted = 0
    for path in delete_paths:
        if path and os.path.isfile(path):
            try:
                os.remove(path); deleted += 1
            except OSError as exc:
                logger.warning(f'[cache-clean] 删除失败 {path}: {exc}')
    after_inventory = _ecommerce_cache_inventory()
    return jsonify({'ok': True, 'mode': mode, 'deleted_files': deleted, 'freed_bytes': before, 'previews_created': previews_created, 'inventory': after_inventory})


@app.route('/api/ecommerce/batches/<batch_id>/record', methods=['DELETE'])
def ecommerce_delete_batch_record(batch_id):
    """删除批次记录（仅元数据，不删除磁盘文件）。

    用于用户主动清理旧批次记录，避免 ecommerce_batches.json 无限增长。
    磁盘文件（_运行缓存、_成品输出）需要用户通过 cache-clean 单独清理。
    """
    with ecommerce_lock:
        store = _ecommerce_load_store()
        batches = store.get('batches', [])
        original_len = len(batches)
        store['batches'] = [b for b in batches if b.get('id') != batch_id]
        if len(store['batches']) == original_len:
            return jsonify({'error': '批次不存在'}), 404
        _ecommerce_save_store(store)
    logger.info(f'[ecommerce] 删除批次记录: {batch_id}')
    return jsonify({'ok': True, 'batch_id': batch_id})


@app.route('/api/ecommerce/batches/<batch_id>/download-zip', methods=['POST'])
def ecommerce_download_batch_zip(batch_id):
    """把批次的所有 AI 生成成品打包成 ZIP 并返回文件路径。

    打包范围：每个服装的 AI 结果目录（_ecommerce_sample_result_dir）
    不包含：原始服装图、_重做历史、_质检缓存等中间产物
    """
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '批次不存在'}), 404

    garments = batch.get('garments') or []
    if not garments:
        return jsonify({'error': '批次没有服装数据'}), 400

    import zipfile
    import tempfile
    batch_name = _ecommerce_safe_name(batch.get('name') or batch_id, batch_id)
    run_code = batch.get('run_code') or 'RUN'
    zip_filename = f"{batch_name}-{run_code}-成品.zip"
    # 临时 ZIP 存到 _运行缓存/_打包下载/
    zip_dir = os.path.join(app_root, '_运行缓存', '_打包下载')
    try:
        os.makedirs(zip_dir, exist_ok=True)
    except OSError as exc:
        return jsonify({'error': f'创建打包目录失败: {exc}'}), 500
    zip_path = os.path.join(zip_dir, zip_filename)

    try:
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            file_count = 0
            # 预构建软删除路径集合
            soft_deleted_paths = set()
            for record in batch.get('deleted_samples') or []:
                if record.get('status') not in {'deleted', 'pending'}:
                    continue
                if not record.get('soft_delete'):
                    continue
                op = record.get('original_path') or ''
                if op:
                    soft_deleted_paths.add(os.path.realpath(os.path.expanduser(op)))
            for garment in garments:
                result_path = _ecommerce_sample_result_dir(batch, garment)
                if not result_path or not os.path.isdir(result_path):
                    continue
                garment_name = _ecommerce_safe_name(garment.get('name') or garment.get('id') or '未命名', garment.get('id') or '')
                # 收集该服装的所有有效成品图（支持带run_code前缀，排除软删除和BJ标记）
                for fname in sorted(os.listdir(result_path)):
                    identity = _ecommerce_sample_identity(fname)
                    if not identity:
                        continue
                    # 排除标记重做(BJ)文件
                    if not identity.get('is_valid_result', False):
                        continue
                    src = os.path.join(result_path, fname)
                    if not os.path.isfile(src):
                        continue
                    # 排除软删除文件
                    if os.path.realpath(src) in soft_deleted_paths:
                        continue
                    # ZIP 内目录结构：服装名/文件名
                    arcname = f"{garment_name}/{fname}"
                    zf.write(src, arcname)
                    file_count += 1
        if file_count == 0:
            os.remove(zip_path)
            return jsonify({'error': '批次没有可打包的成品图'}), 400
        logger.info(f'[ecommerce-zip] 批次 {batch_id} 打包完成: {file_count} 个文件 → {zip_path}')
        return jsonify({
            'ok': True,
            'zip_path': zip_path,
            'zip_filename': zip_filename,
            'file_count': file_count,
            'size_bytes': os.path.getsize(zip_path),
        })
    except Exception as exc:
        logger.error(f'[ecommerce-zip] 打包失败: {exc}', exc_info=True)
        try:
            if os.path.exists(zip_path):
                os.remove(zip_path)
        except OSError:
            pass
        return jsonify({'error': f'打包失败: {exc}'}), 500


@app.route('/api/ecommerce/zip-download/<path:filename>', methods=['GET'])
def ecommerce_serve_zip(filename):
    """提供已打包的 ZIP 文件下载。"""
    safe_name = os.path.basename(filename)
    if safe_name != filename:
        return jsonify({'error': '非法文件名'}), 400
    zip_dir = os.path.join(app_root, '_运行缓存', '_打包下载')
    zip_path = os.path.join(zip_dir, safe_name)
    if not os.path.isfile(zip_path):
        return jsonify({'error': '文件不存在或已被清理'}), 404
    try:
        return send_file(
            zip_path,
            as_attachment=True,
            download_name=safe_name,
            mimetype='application/zip'
        )
    except Exception as exc:
        logger.error(f'[ecommerce-zip] 下载失败: {exc}', exc_info=True)
        return jsonify({'error': f'下载失败: {exc}'}), 500



@app.route('/api/ecommerce/batches/<batch_id>/garments/<garment_id>/compare', methods=['GET'])
def ecommerce_garment_compare(batch_id, garment_id):
    """返回一套服装的实拍参考与生成结果，用于左右切换验片。
    
    查询参数:
        show_deleted=1: 同时显示回收站中已删除的图片预览（用于恢复误删），默认不显示
    """
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404
    garment = _ecommerce_find_garment(batch, garment_id)
    if not garment:
        return jsonify({'error': '找不到服装'}), 404
    show_deleted = str(request.args.get('show_deleted') or '').lower() in {'1', 'true', 'yes'}
    payload = _ecommerce_group_compare_payload(batch, garment, show_deleted=show_deleted)
    if not payload['references']:
        return jsonify({'error': '这套服装没有可读取的实拍参考图'}), 409
    if not payload['results']:
        return jsonify({'error': '这套服装还没有可查看的生成结果或废片备份'}), 409
    return jsonify(payload)


@app.route('/api/ecommerce/final-export-status', methods=['GET'])
def ecommerce_final_export_status():
    batch_id = str(request.args.get('batch_id') or '')
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404
    return jsonify(_ecommerce_final_export_status(batch))


@app.route('/api/ecommerce/final-selection', methods=['POST'])
def ecommerce_final_selection():
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    garment_id = str(body.get('garment_id') or '')
    path = os.path.realpath(os.path.expanduser(str(body.get('path') or '')))
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404
    garment = _ecommerce_find_garment(batch, garment_id)
    if not garment:
        return jsonify({'error': '找不到服装'}), 404
    identity = _ecommerce_result_identity(batch, garment, path)
    candidates = _ecommerce_final_candidates(batch, garment)
    if not identity or path not in (candidates.get(identity['action_order']) or []):
        return jsonify({'error': '所选图片不属于这套服装当前成品目录'}), 409

    def store_selection(stored_batch):
        stored_batch.setdefault('final_selections', {}).setdefault(garment_id, {})[
            str(identity['action_order'])
        ] = path
    _ecommerce_mutate_batch(batch_id, store_selection)
    updated = _ecommerce_batch_snapshot(batch_id)
    return jsonify({
        'ok': True,
        'garment_id': garment_id,
        'action_order': identity['action_order'],
        'selected_path': path,
        'status': _ecommerce_final_export_status(updated),
    })


@app.route('/api/ecommerce/confirm-group', methods=['POST'])
def ecommerce_confirm_group():
    """确认一组服装质检完成，将其从质检列表移到一键导出列表。

    请求体：{ batch_id, garment_id }
    条件：该组没有待重做/待补齐的图片（无活动删除记录、无标记重做、每个动作至少有一张候选图）。
    """
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    garment_id = str(body.get('garment_id') or '')
    if not batch_id or not garment_id:
        return jsonify({'error': '缺少必要参数'}), 400
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404
    garment = _ecommerce_find_garment(batch, garment_id)
    if not garment:
        return jsonify({'error': '找不到服装'}), 404
    # Block confirmation if there are pending marks (user explicitly wants redo)
    active_marks = [
        m for m in (batch.get('marked_redo') or [])
        if m.get('garment_id') == garment_id
    ]
    if active_marks:
        return jsonify({
            'error': f'该组还有{len(active_marks)}张标记重做的图片，请先完成或取消标记',
        }), 409
    # Block if any action is missing candidates (all images deleted for that action)
    candidates = _ecommerce_final_candidates(batch, garment)
    actions = _ecommerce_actions_for_garment(batch, garment)
    missing_actions = []
    for action in actions:
        action_order = int(action.get('order') or 0) + 1
        if not candidates.get(action_order):
            missing_actions.append(action.get('name') or f'目标图{action_order}')
    if missing_actions:
        return jsonify({
            'error': f'以下动作还没有成品图：{", ".join(missing_actions)}',
        }), 409

    def _confirm(stored_batch):
        stored_batch.setdefault('confirmed_groups', {})[garment_id] = {
            'confirmed_at': datetime.now().isoformat(timespec='seconds'),
            'garment_name': garment.get('name') or garment_id,
        }
    _ecommerce_mutate_batch(batch_id, _confirm)
    logger.info(f'[ecommerce-confirm-group] 已确认组 {garment_id}')
    updated = _ecommerce_batch_snapshot(batch_id)
    return jsonify({
        'ok': True,
        'message': '已确认该组',
        'garment_id': garment_id,
        'status': _ecommerce_final_export_status(updated),
    })


@app.route('/api/ecommerce/unconfirm-group', methods=['POST'])
def ecommerce_unconfirm_group():
    """撤销组确认，将其从导出列表退回质检列表。

    请求体：{ batch_id, garment_id }
    """
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    garment_id = str(body.get('garment_id') or '')
    if not batch_id or not garment_id:
        return jsonify({'error': '缺少必要参数'}), 400
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404

    def _unconfirm(stored_batch):
        confirmed = stored_batch.get('confirmed_groups') or {}
        if garment_id in confirmed:
            del confirmed[garment_id]
    _ecommerce_mutate_batch(batch_id, _unconfirm)
    logger.info(f'[ecommerce-unconfirm-group] 已撤销确认组 {garment_id}')
    updated = _ecommerce_batch_snapshot(batch_id)
    return jsonify({
        'ok': True,
        'message': '已撤销确认',
        'garment_id': garment_id,
        'status': _ecommerce_final_export_status(updated),
    })


@app.route('/api/ecommerce/export-final-products', methods=['POST'])
def ecommerce_export_final_products():
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    destination = str(body.get('destination') or '').strip()
    confirmed_only = bool(body.get('confirmed_only'))
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404
    destination, path_error = _ecommerce_safe_user_path(destination, must_exist=True, directory=True)
    if path_error:
        return jsonify({'error': f'导出目录无效：{path_error}'}), 400
    probe = _ecommerce_probe_writable_directory(destination)
    if not probe.get('writable'):
        return jsonify({'error': probe.get('hint') or probe.get('error') or '导出目录不可写'}), 403
    status = _ecommerce_final_export_status(batch)
    confirmed_groups = batch.get('confirmed_groups') or {}
    if confirmed_only:
        # 仅导出已确认组：跳过全局 ready 检查，但已确认组本身必须完整
        export_garments = [
            g for g in (status.get('garments') or [])
            if g.get('garment_id') in confirmed_groups
        ]
        if not export_garments:
            return jsonify({'error': '没有已确认的组可导出'}), 409
    else:
        if not status.get('ready'):
            return jsonify({
                'error': f"最终成品还不完整：缺图{status['missing_actions']}个动作",
                'status': status,
            }), 409
        export_garments = status.get('garments') or []

    # 双保险：即使组在早期版本里被确认，导出前也重新从真实文件目录校验。
    stale_confirmed = [
        garment for garment in export_garments
        if any(action.get('state') != 'complete' for action in garment.get('actions') or [])
    ]
    if stale_confirmed:
        names = '、'.join(garment.get('garment_name') or garment.get('garment_id') or '未命名' for garment in stale_confirmed)
        return jsonify({'error': f'已确认组在导出前校验出现缺图：{names}；请取消确认并补齐后再导出'}), 409

    base_name = f"{_ecommerce_safe_name(batch.get('name') or batch_id, batch_id)}-最终成品-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    export_root = os.path.join(destination, base_name)
    suffix = 2
    while os.path.exists(export_root):
        export_root = os.path.join(destination, f'{base_name}-{suffix}')
        suffix += 1
    _ecommerce_ensure_directory(export_root)
    copied = []
    copied_references = []
    manifest_entries = []
    for garment in export_garments:
        relative_parts = _ecommerce_safe_relative_parts(
            garment.get('relative_path') or garment.get('garment_name') or garment.get('garment_id'),
            fallback=garment.get('garment_name') or garment.get('garment_id'),
        )
        garment_dir = os.path.join(export_root, *relative_parts)
        final_dir = os.path.join(garment_dir, '成品图')
        reference_dir = os.path.join(garment_dir, '服装参考图')
        _ecommerce_ensure_directory(final_dir)
        _ecommerce_ensure_directory(reference_dir)
        garment_confirmed = garment.get('garment_id') in (batch.get('confirmed_groups') or {})
        for action in garment.get('actions') or []:
            for candidate_index, source in enumerate(action.get('candidate_paths') or [], 1):
                if not source or not os.path.isfile(source):
                    return jsonify({'error': f"导出过程中发现图片已不存在：{os.path.basename(source) or source}"}), 409
                source_name = os.path.basename(source)
                target_name = f"{int(action.get('action_order') or 0):02d}-{candidate_index:02d}-{source_name}"
                target = os.path.join(final_dir, target_name)
                _ecommerce_copy_file(source, target)
                copied.append(target)
                manifest_entries.append({
                    'type': 'final_candidate',
                    'file': os.path.join('成品图', target_name),
                    'garment_name': garment.get('garment_name') or '',
                    'garment_id': garment.get('garment_id') or '',
                    'action_order': int(action.get('action_order') or 0),
                    'candidate_index': candidate_index,
                    'source_path': source,
                    'source_filename': source_name,
                    'confirmed': garment_confirmed,
                })
        source_garment = _ecommerce_find_garment(batch, garment.get('garment_id')) or {}
        reference_sources = list(source_garment.get('images') or [])
        if _ecommerce_generation_mode(batch, source_garment) == 'garment_prompt':
            reference_sources.extend(
                action.get('action_image') or ''
                for action in _ecommerce_actions_for_garment(batch, source_garment)
            )
        seen_reference_sources = set()
        for reference_index, source in enumerate(reference_sources, 1):
            source = os.path.realpath(os.path.expanduser(str(source or '')))
            if not source or source in seen_reference_sources or not os.path.isfile(source):
                continue
            seen_reference_sources.add(source)
            source_name = os.path.basename(source)
            target_name = f'{reference_index:02d}-{_ecommerce_safe_name(os.path.splitext(source_name)[0], "reference")}{os.path.splitext(source_name)[1] or ".jpg"}'
            target = os.path.join(reference_dir, target_name)
            _ecommerce_copy_file(source, target)
            copied_references.append(target)
            manifest_entries.append({
                'type': 'garment_reference',
                'file': os.path.join('服装参考图', target_name),
                'garment_name': garment.get('garment_name') or '',
                'garment_id': garment.get('garment_id') or '',
                'source_path': source,
                'source_filename': source_name,
                'confirmed': garment_confirmed,
            })

    # 写入 manifest.json，记录每张图片的来源信息
    import json as _json
    manifest_path = os.path.join(export_root, 'manifest.json')
    try:
        with open(manifest_path, 'w', encoding='utf-8') as f:
            _json.dump({
                'batch_id': batch_id,
                'batch_name': batch.get('name') or '',
                'exported_at': datetime.now().isoformat(timespec='seconds'),
                'file_count': len(copied),
                'reference_file_count': len(copied_references),
                'garment_count': len(export_garments),
                'confirmed_count': len(batch.get('confirmed_groups') or {}),
                'files': manifest_entries,
            }, f, ensure_ascii=False, indent=2)
    except OSError as exc:
        logger.warning(f'[ecommerce-export] manifest.json 写入失败: {exc}')

    exported_at = datetime.now().isoformat(timespec='seconds')
    def record_export(stored_batch):
        stored_batch.setdefault('final_exports', []).append({
            'path': export_root, 'file_count': len(copied),
            'reference_file_count': len(copied_references), 'exported_at': exported_at,
        })
        stored_batch['final_exports'] = stored_batch['final_exports'][-20:]
    _ecommerce_mutate_batch(batch_id, record_export)
    return jsonify({
        'ok': True,
        'path': export_root,
        'file_count': len(copied),
        'reference_file_count': len(copied_references),
        'garment_count': len(export_garments),
        'message': f'已导出{len(copied)}张最终成品和{len(copied_references)}张服装参考图',
    })


@app.route('/api/ecommerce/delete-sample', methods=['POST'])
def ecommerce_delete_sample():
    """在对比界面标记一张AI生成图为"已删除"（软删除，文件不移动）。

    请求体：{ batch_id, garment_id, path, permanent?: false }
    默认软删除：文件保留在源文件夹，对比界面标红显示"已删除"状态。
    当用户提交废片重做时，被标记的图片才会真正移到回收站。
    permanent=true：兼容旧客户端，直接移到系统废纸篓。
    """
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    garment_id = str(body.get('garment_id') or '')
    file_path = str(body.get('path') or '').strip()
    permanent = bool(body.get('permanent', False))
    if not batch_id or not garment_id or not file_path:
        return jsonify({'error': '缺少必要参数'}), 400
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404
    garment = _ecommerce_find_garment(batch, garment_id)
    if not garment:
        return jsonify({'error': '找不到服装'}), 404
    if garment_id in (batch.get('confirmed_groups') or {}):
        return jsonify({'error': '该组已经确认并锁定；请先取消确认，再删除图片'}), 409
    basename = os.path.basename(file_path)
    identity = _ecommerce_result_identity(batch, garment, file_path)
    if not identity:
        return jsonify({'error': '只能删除AI生成图（文件名需含AI-编号）'}), 400
    result_dir = _ecommerce_sample_result_dir(batch, garment)
    cache_root = os.path.expanduser(batch.get('output_path') or '')
    allowed_roots = []
    if result_dir:
        allowed_roots.append(os.path.realpath(result_dir))
    if cache_root:
        allowed_roots.append(os.path.realpath(os.path.join(cache_root, '_生成样本备份')))
    real_file_path = os.path.realpath(os.path.expanduser(file_path))
    if not any(real_file_path.startswith(root) for root in allowed_roots):
        return jsonify({'error': '文件路径不在允许的范围内'}), 403

    # Legacy permanent delete: actually move to trash (backward compat)
    if permanent:
        preview_path = _ecommerce_deleted_preview_path(
            batch, garment, identity['action_order'], real_file_path,
        )
        preview_source = real_file_path if os.path.isfile(real_file_path) else real_file_path + '.deleted'
        try:
            if os.path.isfile(preview_source) and not os.path.isfile(preview_path):
                _ecommerce_create_light_preview(preview_source, preview_path)
        except Exception as exc:
            preview_path = ''
            logger.warning(f'[ecommerce-delete-sample] 废片精确预览备份失败: {exc}')
        try:
            if os.path.isfile(real_file_path):
                if _trash_send is not None:
                    _trash_send(real_file_path)
                else:
                    os.remove(real_file_path)
                logger.info(f'[ecommerce-delete-sample] 已永久删除 {basename}')
            record = _ecommerce_record_deleted_sample(batch_id, garment, real_file_path, preview_path)
            _ecommerce_set_result_asset_status(batch_id, garment_id, real_file_path, 'deleted')
            return jsonify({'ok': True, 'message': f'已删除 {basename}', 'deletion_id': (record or {}).get('id', '')})
        except PermissionError as exc:
            return jsonify({'error': f'权限不足，无法删除: {exc}'}), 403
        except Exception as exc:
            logger.error(f'[ecommerce-delete-sample] 永久删除失败: {exc}', exc_info=True)
            return jsonify({'error': f'删除失败: {exc}'}), 500

    # New soft-delete model: mark the image without moving the file.
    # The file stays in the source folder; the comparison view shows it
    # marked red with "已删除" status. True deletion happens at redo-submit.
    file_exists = os.path.isfile(real_file_path)
    record = _ecommerce_record_deleted_sample(
        batch_id, garment, real_file_path, '', soft_delete=file_exists,
    )
    _ecommerce_set_result_asset_status(batch_id, garment_id, real_file_path, 'deleted')
    logger.info(f'[ecommerce-delete-sample] 软标记删除 {basename} (文件保留={file_exists})')
    return jsonify({
        'ok': True,
        'message': f'已标记删除 {basename}',
        'deletion_id': (record or {}).get('id', ''),
        'soft_delete': True,
        'original_path': real_file_path,
    })


@app.route('/api/ecommerce/undo-delete', methods=['POST'])
def ecommerce_undo_delete():
    """撤销删除：从软件废片回收站（或旧版 .deleted）恢复原名。"""
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    garment_id = str(body.get('garment_id') or '')
    file_path = str(body.get('path') or '').strip()
    deletion_id = str(body.get('deletion_id') or '').strip()
    if not batch_id or not garment_id or not (file_path or deletion_id):
        return jsonify({'error': '缺少必要参数'}), 400
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404
    garment = _ecommerce_find_garment(batch, garment_id)
    if not garment:
        return jsonify({'error': '找不到服装'}), 404
    record = None
    if deletion_id:
        record = next((
            row for row in batch.get('deleted_samples') or []
            if row.get('id') == deletion_id and row.get('garment_id') == garment_id
        ), None)
        if not record:
            return jsonify({'error': '找不到这条删除记录，请重新扫描'}), 404
        file_path = record.get('original_path') or ''
    real_file_path = os.path.realpath(os.path.expanduser(file_path))
    result_dir = _ecommerce_sample_result_dir(batch, garment)
    if not result_dir or os.path.dirname(real_file_path) != os.path.realpath(os.path.expanduser(result_dir)):
        return jsonify({'error': '待恢复文件不属于这套服装的成品目录'}), 403
    try:
        already_restored = os.path.isfile(real_file_path)
        restore_source = 'already_present'
        if not already_restored:
            source, restore_source, move_source = _ecommerce_find_deleted_restore_source(
                batch, garment, record or {}, real_file_path,
            )
            if not source:
                return jsonify({'error': '找不到可恢复的原图、重做备份或预览文件'}), 410
            _ecommerce_restore_deleted_file(
                source,
                real_file_path,
                move_source=move_source,
                preview_source=restore_source == 'preview',
            )
        def restore_deleted_record(stored_batch):
            for record in stored_batch.get('deleted_samples') or []:
                if (
                    record.get('garment_id') == garment_id
                    and os.path.realpath(os.path.expanduser(record.get('original_path') or '')) == real_file_path
                    and record.get('status') in {'deleted', 'pending'}
                ):
                    record['status'] = 'restored'
                    record['restored_at'] = datetime.now().isoformat(timespec='seconds')
        _ecommerce_mutate_batch(batch_id, restore_deleted_record)
        _ecommerce_set_result_asset_status(batch_id, garment_id, real_file_path, 'active')
        logger.info(
            '[ecommerce-undo-delete] 已恢复 %s source=%s',
            os.path.basename(file_path), restore_source,
        )
        return jsonify({
            'ok': True,
            'message': '图片原本已恢复' if already_restored else '已恢复',
            'path': real_file_path,
            'restore_source': restore_source,
            'full_resolution': restore_source != 'preview',
        })
    except Exception as exc:
        logger.error(f'[ecommerce-undo-delete] 撤销失败: {exc}', exc_info=True)
        return jsonify({'error': f'撤销失败: {exc}'}), 500


@app.route('/api/ecommerce/recover-from-recycle', methods=['POST'])
def ecommerce_recover_from_recycle():
    """从回收站找回已删除的图片到源文件夹，与当前生成的图片并列展示供对比。

    请求体：{ batch_id, garment_id, deletion_id }
    在重做提交后，用户可能想对比旧图和新图。此接口从回收站复制（非移动）
    旧图到成品目录，使用唯一文件名避免与新图冲突。
    """
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    garment_id = str(body.get('garment_id') or '')
    deletion_id = str(body.get('deletion_id') or '').strip()
    if not batch_id or not garment_id or not deletion_id:
        return jsonify({'error': '缺少必要参数'}), 400
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404
    garment = _ecommerce_find_garment(batch, garment_id)
    if not garment:
        return jsonify({'error': '找不到服装'}), 404
    record = next((
        row for row in batch.get('deleted_samples') or []
        if row.get('id') == deletion_id and row.get('garment_id') == garment_id
    ), None)
    if not record:
        return jsonify({'error': '找不到这条删除记录'}), 404
    recycle_path = os.path.realpath(os.path.expanduser(record.get('recycle_path') or ''))
    if not recycle_path or not os.path.isfile(recycle_path):
        return jsonify({'error': '回收站中找不到该图片，可能已被清理'}), 410
    result_dir = _ecommerce_sample_result_dir(batch, garment)
    if not result_dir:
        return jsonify({'error': '找不到成品目录'}), 500
    _ecommerce_ensure_directory(result_dir)
    original_name = os.path.basename(record.get('original_path') or recycle_path)
    stem, ext = os.path.splitext(original_name)
    target = os.path.join(result_dir, f'{stem}-recovered{ext}')
    recovered_path = _ecommerce_unique_copy(recycle_path, target)
    # Mark the deletion record as 'recovered' so it no longer blocks group confirmation.
    # The file has been brought back (at a new path) for the user to compare and decide.
    def mark_recovered(stored_batch):
        for row in stored_batch.get('deleted_samples') or []:
            if row.get('id') == deletion_id:
                row['status'] = 'recovered'
                row['recovered_at'] = datetime.now().isoformat(timespec='seconds')
                row['recovered_path'] = recovered_path
                break
    _ecommerce_mutate_batch(batch_id, mark_recovered)
    logger.info(f'[ecommerce-recover] 从回收站找回 {original_name} → {os.path.basename(recovered_path)}')
    return jsonify({
        'ok': True,
        'message': f'已找回 {original_name}',
        'recovered_path': recovered_path,
    })


@app.route('/api/ecommerce/mark-redo', methods=['POST'])
def ecommerce_mark_redo():
    """标记某张AI图为"待重做"（不删除原图，重做后新旧图共存）。

    请求体：{ batch_id, garment_id, action_order, result_path }
    在批次数据中记录 marked_redo 列表。
    """
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    garment_id = str(body.get('garment_id') or '')
    action_order = int(body.get('action_order') or 0)
    result_path = str(body.get('result_path') or '').strip()
    if not batch_id or not garment_id or not action_order:
        return jsonify({'error': '缺少必要参数'}), 400
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404
    garment = _ecommerce_find_garment(batch, garment_id)
    if not garment:
        return jsonify({'error': '找不到服装'}), 404
    if garment_id in (batch.get('confirmed_groups') or {}):
        return jsonify({'error': '该组已经确认并锁定；请先取消确认，再标记重做'}), 409
    result_real = ''
    if result_path:
        result_real = os.path.realpath(os.path.expanduser(result_path))
        result_dir = os.path.realpath(os.path.expanduser(_ecommerce_sample_result_dir(batch, garment) or ''))
        identity = _ecommerce_result_identity(batch, garment, result_real)
        if (
            not result_dir or os.path.dirname(result_real) != result_dir
            or not os.path.isfile(result_real)
            or not identity or identity['action_order'] != action_order
        ):
            return jsonify({'error': '标记的图片不属于这套服装的对应动作，请刷新后重试'}), 409

    def _add_mark(b):
        marked = b.setdefault('marked_redo', [])
        # 新版按具体结果图去重；无路径的旧客户端仍兼容按动作标记。
        for m in marked:
            if m.get('garment_id') != garment_id or int(m.get('action_order') or 0) != action_order:
                continue
            marked_real = os.path.realpath(os.path.expanduser(m.get('result_path') or ''))
            if (result_real and marked_real == result_real) or (not result_real and not m.get('result_path')):
                return m
        row = {
            'id': gen_id('ecmark'),
            'garment_id': garment_id,
            'action_order': action_order,
            'result_path': result_real,
            'marked_at': datetime.now().isoformat(timespec='seconds'),
        }
        marked.append(row)
        return row

    mark = _ecommerce_mutate_batch(batch_id, _add_mark)
    if result_real:
        _ecommerce_set_result_asset_status(batch_id, garment_id, result_real, 'marked_redo')
    logger.info(f'[ecommerce-mark-redo] 已标记重做 batch={batch_id} garment={garment_id} action={action_order}')
    return jsonify({'ok': True, 'message': '已标记为待重做', 'mark_id': (mark or {}).get('id', '')})


@app.route('/api/ecommerce/unmark-redo', methods=['POST'])
def ecommerce_unmark_redo():
    """取消标记重做。

    请求体：{ batch_id, garment_id, action_order }
    """
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    garment_id = str(body.get('garment_id') or '')
    action_order = int(body.get('action_order') or 0)
    mark_id = str(body.get('mark_id') or '').strip()
    result_path = str(body.get('result_path') or '').strip()
    result_real = os.path.realpath(os.path.expanduser(result_path)) if result_path else ''
    if not batch_id or not garment_id or not action_order:
        return jsonify({'error': '缺少必要参数'}), 400

    def _remove_mark(b):
        marked = b.get('marked_redo') or []
        def should_remove(mark):
            if mark.get('garment_id') != garment_id or int(mark.get('action_order') or 0) != action_order:
                return False
            if mark_id:
                return mark.get('id') == mark_id
            if result_real:
                return os.path.realpath(os.path.expanduser(mark.get('result_path') or '')) == result_real
            return True
        b['marked_redo'] = [mark for mark in marked if not should_remove(mark)]

    _ecommerce_mutate_batch(batch_id, _remove_mark)
    if result_real:
        _ecommerce_set_result_asset_status(batch_id, garment_id, result_real, 'active')
    return jsonify({'ok': True, 'message': '已取消标记'})


@app.route('/api/ecommerce/cancel-rerun-items', methods=['POST'])
def ecommerce_cancel_rerun_items():
    """取消第五步中的一张或一套待重做项。

    删除产生的废片会恢复原文件；手动标记产生的项会撤销标记。
    每个请求项都以删除记录ID/标记ID精确绑定，不能按返回顺序误归属。
    """
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    requested = body.get('items') or []
    if not batch_id or not isinstance(requested, list) or not requested:
        return jsonify({'error': '没有可取消的待重做项'}), 400
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404

    outcomes = []
    for raw in requested:
        item_id = str((raw or {}).get('item_id') or '')
        garment_id = str((raw or {}).get('garment_id') or '')
        try:
            action_order = int((raw or {}).get('action_order') or 0)
        except (TypeError, ValueError):
            action_order = 0
        garment = _ecommerce_find_garment(batch, garment_id)
        errors = []
        restored = 0
        unmarked = 0
        if not garment or action_order < 1:
            outcomes.append({'item_id': item_id, 'ok': False, 'errors': ['服装或动作信息无效']})
            continue

        deletion_ids = list(dict.fromkeys(str(value) for value in ((raw or {}).get('deletion_ids') or []) if value))
        for deletion_id in deletion_ids:
            current = _ecommerce_batch_snapshot(batch_id) or {}
            record = next((
                row for row in current.get('deleted_samples') or []
                if row.get('id') == deletion_id
                and row.get('garment_id') == garment_id
                and int(row.get('action_order') or 0) == action_order
                and row.get('status') in {'deleted', 'pending'}
            ), None)
            if not record:
                # 已经恢复/取消过时按幂等成功处理。
                historical = next((row for row in current.get('deleted_samples') or [] if row.get('id') == deletion_id), None)
                if historical and historical.get('status') == 'restored':
                    continue
                errors.append(f'删除记录 {deletion_id} 已失效，请刷新后重试')
                continue
            original_path = os.path.realpath(os.path.expanduser(record.get('original_path') or ''))
            result_dir = _ecommerce_sample_result_dir(current, garment)
            if not result_dir or os.path.dirname(original_path) != os.path.realpath(os.path.expanduser(result_dir)):
                errors.append('待恢复文件不属于本套成品目录')
                continue
            if not os.path.isfile(original_path):
                recycle_path = os.path.realpath(os.path.expanduser(record.get('recycle_path') or '')) if record.get('recycle_path') else ''
                deleted_path = original_path + '.deleted'
                restore_source = recycle_path if recycle_path and os.path.isfile(recycle_path) else deleted_path
                if not os.path.isfile(restore_source):
                    errors.append(f'{os.path.basename(original_path)} 的废片回收文件不存在，可能已被清理')
                    continue
                try:
                    os.rename(restore_source, original_path)
                except OSError as exc:
                    errors.append(f'恢复 {os.path.basename(original_path)} 失败：{exc}')
                    continue
            def _mark_restored(stored_batch, target_id=deletion_id):
                for row in stored_batch.get('deleted_samples') or []:
                    if row.get('id') == target_id:
                        row['status'] = 'restored'
                        row['restored_at'] = datetime.now().isoformat(timespec='seconds')
            _ecommerce_mutate_batch(batch_id, _mark_restored)
            restored += 1

        mark_ids = list(dict.fromkeys(
            str(value) for value in (
                list((raw or {}).get('mark_ids') or []) + [str((raw or {}).get('mark_id') or '')]
            ) if value
        ))
        marked_result_path = str((raw or {}).get('marked_result_path') or '')
        marked_result_real = os.path.realpath(os.path.expanduser(marked_result_path)) if marked_result_path else ''
        if mark_ids or marked_result_real:
            removed_holder = {'count': 0}
            def _remove_marks(stored_batch):
                kept = []
                for mark in stored_batch.get('marked_redo') or []:
                    same_scope = (
                        mark.get('garment_id') == garment_id
                        and int(mark.get('action_order') or 0) == action_order
                    )
                    mark_real = os.path.realpath(os.path.expanduser(mark.get('result_path') or '')) if mark.get('result_path') else ''
                    exact = (mark.get('id') in mark_ids) or (marked_result_real and mark_real == marked_result_real)
                    if same_scope and exact:
                        removed_holder['count'] += 1
                    else:
                        kept.append(mark)
                stored_batch['marked_redo'] = kept
            _ecommerce_mutate_batch(batch_id, _remove_marks)
            unmarked = removed_holder['count']

        outcomes.append({
            'item_id': item_id,
            'ok': not errors,
            'restored_count': restored,
            'unmarked_count': unmarked,
            'errors': errors,
        })

    cancelled_ids = [row['item_id'] for row in outcomes if row.get('ok')]
    failures = [error for row in outcomes for error in row.get('errors') or []]
    return jsonify({
        'ok': not failures,
        'cancelled_item_ids': cancelled_ids,
        'outcomes': outcomes,
        'restored_count': sum(int(row.get('restored_count') or 0) for row in outcomes),
        'unmarked_count': sum(int(row.get('unmarked_count') or 0) for row in outcomes),
        'errors': failures,
    }), (200 if cancelled_ids or not failures else 409)


@app.route('/api/ecommerce/scan-deleted', methods=['POST'])
def ecommerce_scan_deleted():
    """扫描批次内每套服装的 AI 结果目录，找出被删掉的动作图并返回重做清单。

    每条记录包含：服装信息、动作信息、废片备份URL、目标动作图URL、6张服装参考图URL、原提示词。
    """
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404
    generation_mode = _ecommerce_generation_mode(batch)
    garments = sorted(batch.get('garments', []), key=lambda g: int(g.get('order') or 0))
    cache_root = os.path.expanduser(batch.get('output_path') or '')
    requested_result_path = str(body.get('result_path') or '').strip()
    if requested_result_path:
        requested_result_path, path_error = _ecommerce_safe_user_path(requested_result_path, must_exist=True)
        if path_error:
            return jsonify({'error': f'扫描目录无效: {path_error}'}), 400
        matched = []
        for garment in garments:
            actual = _ecommerce_sample_result_dir(batch, garment)
            if actual and os.path.realpath(os.path.expanduser(actual)) == requested_result_path:
                matched.append(garment)
        if not matched:
            return jsonify({'error': '所选文件夹不属于当前批次，请选择该批次结果列表中的某一套服装文件夹'}), 400
        garments = matched
    items = []
    scan_deleted_original_paths = set()
    confirmed_groups = batch.get('confirmed_groups') or {}
    for garment in garments:
        # Skip confirmed groups — they've passed QC and moved to the export list.
        if garment.get('id') in confirmed_groups:
            continue
        garment_actions = _ecommerce_actions_for_garment(batch, garment)
        action_count = len(garment_actions)
        expected_samples = max(1, min(int((batch.get('settings') or {}).get('samples_per_action') or 1), 5))
        if not action_count:
            continue
        garment_path = garment.get('path') or ''
        garment_name = garment.get('name') or garment.get('id') or '未命名'
        result_path = _ecommerce_sample_result_dir(batch, garment)

        # 构建软删除路径集合（这些文件虽在磁盘但已被用户标记删除，不算有效图）
        soft_deleted_paths = set()
        for record in batch.get('deleted_samples') or []:
            if record.get('garment_id') != garment.get('id'):
                continue
            if record.get('status') not in {'deleted', 'pending'}:
                continue
            if not record.get('soft_delete'):
                continue
            op = record.get('original_path') or ''
            if op:
                soft_deleted_paths.add(os.path.realpath(os.path.expanduser(op)))

        # 扫描结果目录，统计每个动作的有效成品数量（排除软删除和当前台账标记）。
        # BJ文件是标记重做返回的正常候选，不应排除。
        valid_counts = {}
        bj_paths = set()
        if result_path and os.path.isdir(result_path):
            try:
                for name in os.listdir(result_path):
                    fpath = os.path.join(result_path, name)
                    if not os.path.isfile(fpath) or name.lower().endswith('.deleted'):
                        continue
                    identity = _ecommerce_result_identity(batch, garment, fpath)
                    if not identity:
                        continue
                    order = identity['action_order']
                    real = os.path.realpath(fpath)
                    if real in soft_deleted_paths:
                        continue
                    if identity.get('is_marked_redo'):
                        bj_paths.add(real)
                        # 只兼容旧版身份数据；新版BJ不会进入此分支。
                        continue
                    valid_counts[order] = valid_counts.get(order, 0) + 1
            except OSError:
                pass

        # 抽卡模式按目标数量检查，不能只检查“至少有一张”。
        filesystem_missing = [i for i in range(1, action_count + 1) if valid_counts.get(i, 0) < expected_samples]

        # 收集活跃删除记录
        active_deletions_by_action = {}
        for deleted_record in _ecommerce_active_deleted_samples(batch, garment.get('id')):
            order = int(deleted_record.get('action_order') or 0)
            if 1 <= order <= action_count:
                active_deletions_by_action.setdefault(order, []).append(deleted_record)
        # 兼容历史推断删除
        for deleted_record in _ecommerce_infer_historical_deletions(batch, garment, result_path, 1):
            order = int(deleted_record.get('action_order') or 0)
            if 1 <= order <= action_count:
                active_deletions_by_action.setdefault(order, []).append(deleted_record)

        # 自动解决"已有有效图覆盖"的删除记录：
        # 如果某动作已经有≥1张有效成品，则该动作的硬删除记录（非软删除、非推断）自动标记为auto_resolved
        auto_resolved_ids = []
        for order, records in list(active_deletions_by_action.items()):
            if valid_counts.get(order, 0) >= 1:
                for rec in records:
                    if not rec.get('soft_delete') and not rec.get('inferred_from_archive') and rec.get('id'):
                        orig = rec.get('original_path') or ''
                        if not orig or not os.path.isfile(os.path.realpath(os.path.expanduser(orig))):
                            auto_resolved_ids.append(rec['id'])
        if auto_resolved_ids:
            _ecommerce_auto_resolve_stale_deletions(batch_id, auto_resolved_ids)
            # 刷新active_deletions
            active_deletions_by_action = {}
            for deleted_record in _ecommerce_active_deleted_samples(batch, garment.get('id')):
                order = int(deleted_record.get('action_order') or 0)
                if 1 <= order <= action_count:
                    active_deletions_by_action.setdefault(order, []).append(deleted_record)
            for deleted_record in _ecommerce_infer_historical_deletions(batch, garment, result_path, 1):
                order = int(deleted_record.get('action_order') or 0)
                if 1 <= order <= action_count:
                    active_deletions_by_action.setdefault(order, []).append(deleted_record)

        # 需要进入废片列表的动作：抽卡有效成品未达到目标数量，或有活跃删除记录造成缺口。
        # 注意：软删除的文件仍在磁盘上但被标记删除，如果同动作还有其他有效图则OK；
        # 如果所有图都被软删除（valid_counts=0），则该动作缺图
        scan_orders = set()
        for order in filesystem_missing:
            scan_orders.add(order)
        # 对于有删除记录但有效图=0的动作，也加入
        for order in active_deletions_by_action:
            if valid_counts.get(order, 0) < expected_samples:
                scan_orders.add(order)

        if not scan_orders:
            continue
        # 使用创建批次时冻结的实际参考图，不能重新扫描后误选到别的照片。
        frozen_images = list(garment.get('images') or [])
        garment_references = [{'url': _ecommerce_local_image_url(path), 'path': path, 'override_url': '', 'override_path': '', 'role': 'garment'} for path in frozen_images[:10]]
        # 备份目录
        backup_dir = os.path.join(cache_root, '_生成样本备份', _ecommerce_safe_name(garment_name, garment_name)) if cache_root else ''
        for action_order in scan_orders:
            idx = action_order - 1
            action = next((a for a in garment_actions if int(a.get('order') or 0) == idx), None)
            if not action:
                continue
            target_reference = _ecommerce_target_reference(action)
            if generation_mode in {'target_only', 'garment_prompt'} and target_reference:
                references = [target_reference]
                if generation_mode == 'garment_prompt':
                    references[0]['role'] = 'source_garment'
            else:
                references = list(garment_references)
            # 废片备份路径（单张 AI-01.jpg 或多张 AI-01-1.jpg 等，取第一张）
            related_task = next((
                t for t in batch.get('tasks', [])
                if t.get('garment_id') == garment.get('id') and int(t.get('action_order') or 0) == idx
            ), None)
            deleted_records = sorted(
                active_deletions_by_action.get(action_order) or [],
                key=lambda row: row.get('deleted_at') or '',
                reverse=True,
            )
            scan_deleted_original_paths.update(
                os.path.realpath(os.path.expanduser(row.get('original_path') or ''))
                for row in deleted_records if row.get('original_path')
            )
            # For soft-deleted records the file is still on disk — use it
            # directly as the "bad photo" for comparison, no preview needed.
            bad_photo_path = next((
                row.get('original_path') for row in deleted_records
                if row.get('soft_delete') and row.get('original_path')
                and os.path.isfile(row.get('original_path'))
            ), '')
            if not bad_photo_path:
                bad_photo_path = next((
                    row.get('preview_path') for row in deleted_records
                    if row.get('preview_path') and os.path.isfile(row.get('preview_path'))
                ), '')
            if not bad_photo_path:
                bad_photo_path = _ecommerce_task_preview_path(batch, related_task) if related_task else ''
            if backup_dir and os.path.isdir(backup_dir):
                for name in sorted(os.listdir(backup_dir)):
                    identity = _ecommerce_sample_identity(name)
                    if identity and identity['action_order'] == action_order:
                        if not os.path.isfile(bad_photo_path):
                            bad_photo_path = os.path.join(backup_dir, name)
                        break
            # fallback目录可能同时就是工作副本，用户删除后从任务候选缓存恢复预览。
            if not bad_photo_path or not os.path.isfile(bad_photo_path):
                candidate_attempt = next((
                    a for a in reversed((related_task or {}).get('attempts', []))
                    if a.get('candidate_path') and os.path.isfile(a.get('candidate_path'))
                ), None)
                bad_photo_path = (candidate_attempt or {}).get('candidate_path') or ''
            # 最后兜底：从 _生成样本备份 中找同动作号的任何文件（包括重做后的 -RR 文件）
            if not bad_photo_path or not os.path.isfile(bad_photo_path):
                cache_root = os.path.expanduser(batch.get('output_path') or '')
                if cache_root:
                    gen_backup_dir = os.path.join(cache_root, '_生成样本备份', _ecommerce_safe_name(garment_name, garment.get('id') or garment_name))
                    if os.path.isdir(gen_backup_dir):
                        for name in sorted(os.listdir(gen_backup_dir), reverse=True):
                            identity = _ecommerce_sample_identity(name)
                            if identity and identity['action_order'] == action_order:
                                bad_photo_path = os.path.join(gen_backup_dir, name)
                                break
            current_model = (related_task or {}).get('result_model') or _ecommerce_action_model_signature(action)
            deleted_originals = {
                os.path.realpath(os.path.expanduser(row.get('original_path') or ''))
                for row in deleted_records if row.get('original_path')
            }
            overlapping_marks = [
                mark for mark in batch.get('marked_redo') or []
                if mark.get('garment_id') == garment.get('id')
                and int(mark.get('action_order') or 0) == action_order
                and mark.get('result_path')
                and os.path.realpath(os.path.expanduser(mark.get('result_path') or '')) in deleted_originals
            ]
            # 计算有效成品数量
            valid_count = valid_counts.get(action_order, 0)
            missing_count = max(0, expected_samples - valid_count)
            items.append({
                'id': f"{garment.get('id')}-{action_order}",
                'garment_id': garment.get('id'),
                'garment_name': garment_name,
                'garment_path': garment_path,
                'result_path': result_path,
                'action_order': action_order,
                'action_name': action.get('name') or f'目标图{action_order}',
                'action_id': action.get('id'),
                'bad_photo_url': _ecommerce_local_image_url(bad_photo_path),
                'bad_photo_path': bad_photo_path,
                'target_action_url': _ecommerce_local_image_url(action.get('action_image') or ''),
                'target_action_path': action.get('action_image') or '',
                'references': references,
                'generation_mode': generation_mode,
                'original_prompt': action.get('prompt') or '',
                'original_model': {
                    'platform': current_model.get('platform') or action.get('platform') or 'runninghub',
                    'model_key': current_model.get('model_key') or action.get('model_key') or action.get('model_id') or '',
                    'aspect_ratio': current_model.get('aspect_ratio') or action.get('aspect_ratio') or 'auto',
                },
                'model_signature': current_model,
                'samples_per_action': expected_samples,
                'expected_count': expected_samples,
                'actual_count': valid_count,
                'missing_count': missing_count,
                'deletion_ids': [row.get('id') for row in deleted_records if row.get('id')],
                'deleted_record_count': len(deleted_records),
                'also_marked_redo': bool(overlapping_marks),
                'merged_mark_ids': [mark.get('id') for mark in overlapping_marks if mark.get('id')],
            })
    garment_ids = [g.get('id') for g in garments]
    scope_label = garments[0].get('name') if requested_result_path and len(garments) == 1 else '整批'
    stats = _ecommerce_record_waste_scan(batch, items, garment_ids if requested_result_path else None, scope_label)

    # 额外返回"标记重做"的项（文件未删除，但用户标记了想重做对比）
    marked_items = []
    marked_redo = batch.get('marked_redo') or []
    emitted_mark_keys = set()
    for mark in marked_redo:
        m_garment_id = mark.get('garment_id')
        m_action_order = int(mark.get('action_order') or 0)
        # 如果指定了单组扫描，只返回该组的标记
        garment = next((g for g in garments if g.get('id') == m_garment_id), None)
        if not garment:
            continue
        generation_mode = _ecommerce_generation_mode(batch, garment)
        # Skip marks for confirmed groups
        if m_garment_id in confirmed_groups:
            continue
        marked_result_path = os.path.realpath(os.path.expanduser(mark.get('result_path') or '')) if mark.get('result_path') else ''
        mark_key = (m_garment_id, m_action_order, marked_result_path or '__legacy_action__')
        if mark_key in emitted_mark_keys:
            continue
        emitted_mark_keys.add(mark_key)
        # 只有“同一张具体图”既被标记又被删除时才合并。
        # 同动作的另一张标记图仍必须单独返回，不能被删除项隐藏。
        active_deleted_paths = {
            os.path.realpath(os.path.expanduser(row.get('original_path') or ''))
            for row in _ecommerce_active_deleted_samples(batch, m_garment_id, m_action_order)
            if row.get('original_path')
        }
        active_deleted_paths.update(scan_deleted_original_paths)
        if marked_result_path and marked_result_path in active_deleted_paths:
            continue
        garment_name = garment.get('name') or garment.get('id') or '未命名'
        idx = m_action_order - 1
        garment_actions = _ecommerce_actions_for_garment(batch, garment)
        action = next((a for a in garment_actions if int(a.get('order') or 0) == idx), None)
        if not action:
            continue
        result_path = _ecommerce_sample_result_dir(batch, garment)
        frozen_images = list(garment.get('images') or [])
        if generation_mode in {'target_only', 'garment_prompt'}:
            target_reference = _ecommerce_target_reference(action)
            references = [target_reference] if target_reference else []
            if references and generation_mode == 'garment_prompt':
                references[0]['role'] = 'source_garment'
        else:
            references = [{'url': _ecommerce_local_image_url(path), 'path': path, 'override_url': '', 'override_path': '', 'role': 'garment'} for path in frozen_images[:10]]
        # 精确标记优先使用原图；旧数据才按动作号回退查找。
        bad_photo_path = marked_result_path if marked_result_path and os.path.isfile(marked_result_path) else ''
        if not bad_photo_path and result_path and os.path.isdir(result_path):
            for name in sorted(os.listdir(result_path), reverse=True):
                candidate_path = os.path.join(result_path, name)
                if not os.path.isfile(candidate_path) or name.lower().endswith('.deleted'):
                    continue
                identity = _ecommerce_result_identity(batch, garment, candidate_path)
                if identity and identity['action_order'] == m_action_order:
                    bad_photo_path = os.path.join(result_path, name)
                    break
        related_task = next((
            t for t in batch.get('tasks', [])
            if t.get('garment_id') == m_garment_id and int(t.get('action_order') or 0) == idx
        ), None)
        current_model = (related_task or {}).get('result_model') or _ecommerce_action_model_signature(action)
        mark_token = mark.get('id') or hashlib.sha256(
            (marked_result_path or f'{m_garment_id}:{m_action_order}').encode('utf-8')
        ).hexdigest()[:12]
        marked_items.append({
            'id': f"{m_garment_id}-{m_action_order}-marked-{mark_token}",
            'garment_id': m_garment_id,
            'garment_name': garment_name,
            'garment_path': garment.get('path') or '',
            'result_path': result_path,
            'action_order': m_action_order,
            'action_name': action.get('name') or f'目标图{m_action_order}',
            'action_id': action.get('id'),
            'bad_photo_url': _ecommerce_local_image_url(bad_photo_path),
            'bad_photo_path': bad_photo_path,
            'target_action_url': _ecommerce_local_image_url(action.get('action_image') or ''),
            'target_action_path': action.get('action_image') or '',
            'references': references,
            'generation_mode': generation_mode,
            'original_prompt': action.get('prompt') or '',
            'original_model': {
                'platform': current_model.get('platform') or action.get('platform') or 'runninghub',
                'model_key': current_model.get('model_key') or action.get('model_key') or action.get('model_id') or '',
                'aspect_ratio': current_model.get('aspect_ratio') or action.get('aspect_ratio') or 'auto',
            },
            'model_signature': current_model,
            'marked_redo': True,  # 标记为"重做对比"而非"缺失废片"
            'mark_id': mark.get('id') or '',
            'marked_result_path': marked_result_path,
            'missing_count': 1,
        })
    items.extend(marked_items)
    return jsonify({
        'items': items, 'total': len(items), 'stats': stats,
        'marked_count': len(marked_items), 'generation_mode': generation_mode,
        'confirmed_groups': confirmed_groups,
        'confirmed_count': len(confirmed_groups),
    })


@app.route('/api/ecommerce/upload-temp-image', methods=['POST'])
def ecommerce_upload_temp_image():
    """上传一张临时图片（用于废片重做时替换服装参考图），返回 local-image URL。"""
    file = request.files.get('file')
    batch_id = str(request.form.get('batch_id') or '')
    if not file or not file.filename:
        return jsonify({'error': '未选择文件'}), 400
    batch = _ecommerce_batch_snapshot(batch_id) if batch_id else None
    cache_root = os.path.expanduser((batch or {}).get('output_path') or '~/Downloads/电商批量生图')
    temp_dir = os.path.join(cache_root, '_重做临时参考图')
    os.makedirs(temp_dir, exist_ok=True)
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ECOMMERCE_IMAGE_EXTS:
        ext = '.jpg'
    filename = f"temp-{datetime.now().strftime('%Y%m%d%H%M%S')}-{gen_id('tmp')}{ext}"
    target = os.path.join(temp_dir, filename)
    file.save(target)
    return jsonify({'url': _ecommerce_local_image_url(target), 'path': target})


def _ecommerce_validate_rerun_queue_item(batch, raw):
    item_id = str((raw or {}).get('item_id') or (raw or {}).get('id') or '').strip()
    clean_item_id = item_id.split('-marked', 1)[0] if '-marked' in item_id else item_id
    try:
        garment_id, action_order_text = clean_item_id.rsplit('-', 1)
        action_order = int(action_order_text)
    except (ValueError, AttributeError):
        raise ValueError(f'废片任务编号无效: {item_id}')
    garment = _ecommerce_find_garment(batch, garment_id)
    if not garment:
        raise ValueError(f'找不到废片对应服装: {item_id}')
    task = next((task for task in batch.get('tasks', [])
                 if task.get('garment_id') == garment_id
                 and int(task.get('action_order') or 0) == action_order - 1), None)
    if not task:
        raise ValueError(f'找不到废片对应动作: {item_id}')
    expected_result_path = os.path.realpath(_ecommerce_sample_result_dir(batch, garment) or '')
    requested_result_path = os.path.realpath(os.path.expanduser(str((raw or {}).get('result_path') or expected_result_path)))
    if not expected_result_path or requested_result_path != expected_result_path:
        raise ValueError(f'废片结果目录不匹配: {item_id}')
    payload = {
        'batch_id': batch.get('id'), 'item_id': item_id,
        'result_path': expected_result_path,
        'deletion_ids': [
            str(value) for value in list((raw or {}).get('deletion_ids') or [])[:5]
            if str(value or '').strip()
        ],
        'mark_id': str((raw or {}).get('mark_id') or ''),
        'marked_result_path': str((raw or {}).get('marked_result_path') or ''),
        'mode': str((raw or {}).get('mode') or 'full'),
        'prompt': str((raw or {}).get('prompt') or ''),
        'reference_images': list((raw or {}).get('reference_images') or [])[:9],
        # 仅覆盖这一项废片重做所使用的动作参考图；不修改原批次模板，
        # 也不能被“同步本套”误用到其他动作。
        'target_action_image': str((raw or {}).get('target_action_image') or '').strip(),
        'count': max(1, min(int((raw or {}).get('count') or 1), 5)),
        'model_override': dict((raw or {}).get('model_override') or {}),
    }
    requested_count = payload['count']
    return {
        'id': str((raw or {}).get('queue_id') or gen_id('ecritem')),
        'item_id': item_id, 'garment_id': garment_id,
        'garment_name': garment.get('name') or garment_id,
        'action_order': action_order,
        'action_name': task.get('action_name') or f'目标图{action_order}',
        'status': 'pending', 'payload': payload, 'archived_paths': [],
        'requested_count': requested_count, 'success_count': 0,
        'remaining_count': requested_count,
        'created_at': datetime.now().isoformat(timespec='seconds'),
    }


def _ecommerce_recycle_soft_deleted_for_action(batch, garment, action_order):
    """把指定服装+动作下所有活跃的软删除文件立即移到回收站。

    在递交重做（创建rerun-batch）时调用，确保用户点击"开始重做"的那一刻，
    被标记为废片的文件就从原目录消失，而不是等到worker处理时才移走。
    同时清理task中对这些文件的引用（accepted_path等），避免对比图加载不存在的文件。
    返回 (recycled_count, failed_count)。
    """
    garment_id = garment.get('id')
    batch_id = batch.get('id')
    active_deletions = [
        row for row in batch.get('deleted_samples') or []
        if row.get('garment_id') == garment_id
        and int(row.get('action_order') or 0) == action_order
        and row.get('status') in {'deleted', 'pending'}
        and row.get('soft_delete')
    ]
    recycled_count = 0
    failed_count = 0
    recycled_paths = {}
    recycled_real_paths = set()
    for row in active_deletions:
        original = row.get('original_path') or ''
        if not original:
            continue
        original_real = os.path.realpath(os.path.expanduser(original))
        if not os.path.isfile(original_real):
            # 文件已经不在磁盘上了（可能已被手动删除或之前的操作移走），直接标记为非软删除
            recycled_paths[row.get('id')] = ''
            continue
        recycle = _ecommerce_deleted_recycle_path(batch, garment, original_real)
        if not recycle:
            failed_count += 1
            continue
        try:
            os.makedirs(os.path.dirname(recycle), exist_ok=True)
            os.rename(original_real, recycle)
            recycled_paths[row.get('id')] = os.path.realpath(recycle)
            recycled_real_paths.add(original_real)
            recycled_count += 1
            logger.info(f'[ecommerce-rerun] 移走软删除文件到回收站: {os.path.basename(original_real)}')
        except OSError as exc:
            logger.warning(f'[ecommerce-rerun] 移走软删除文件失败 {original_real}: {exc}')
            failed_count += 1

    if recycled_paths or recycled_real_paths:
        def _apply(b):
            # 更新删除记录
            for row in b.get('deleted_samples') or []:
                if row.get('id') in recycled_paths:
                    row['soft_delete'] = False
                    rp = recycled_paths[row.get('id')]
                    if rp:
                        row['recycle_path'] = rp
            # 同时清理task中对已移走文件的引用，避免accepted_path指向不存在的文件
            for task in b.get('tasks') or []:
                if task.get('garment_id') != garment_id:
                    continue
                if int(task.get('action_order') or 0) != action_order - 1:
                    continue
                # 检查accepted_path
                ap = task.get('accepted_path') or ''
                if ap and os.path.realpath(os.path.expanduser(ap)) in recycled_real_paths:
                    task['accepted_path'] = ''
                # 检查manual_review_path
                mrp = task.get('manual_review_path') or ''
                if mrp and os.path.realpath(os.path.expanduser(mrp)) in recycled_real_paths:
                    task['manual_review_path'] = ''
                # 清理attempts中的archived_path引用
                for attempt in task.get('attempts') or []:
                    arch = attempt.get('archived_path') or ''
                    if arch and os.path.realpath(os.path.expanduser(arch)) in recycled_real_paths:
                        # 不删除attempt记录，但标记archived_path对应的文件已被删除
                        attempt['archived_deleted'] = True
        _ecommerce_mutate_batch(batch_id, _apply)

    return recycled_count, failed_count


@app.route('/api/ecommerce/rerun-batches', methods=['GET', 'POST'])
def ecommerce_rerun_batches():
    if request.method == 'GET':
        batch_id = str(request.args.get('batch_id') or '')
        with ecommerce_lock:
            rows = list(_ecommerce_load_store().get('rerun_batches') or [])
        if batch_id:
            rows = [row for row in rows if row.get('batch_id') == batch_id]
        rows.sort(key=lambda row: row.get('created_at') or '', reverse=True)
        return jsonify({'rerun_batches': [_ecommerce_rerun_batch_summary(row) for row in rows[:20]]})
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到原始批次'}), 404
    raw_items = body.get('items') or []
    if not isinstance(raw_items, list) or not raw_items:
        return jsonify({'error': '没有可创建重做批次的任务'}), 400
    try:
        items = [_ecommerce_validate_rerun_queue_item(batch, raw) for raw in raw_items[:500]]
    except (ValueError, TypeError) as exc:
        return jsonify({'error': str(exc)}), 400

    # 创建新批次前，自动清理同一batch下已卡住的running rerun-batch：
    # 如果一个rerun-batch状态为running但所有任务都已结束（accepted/failed）或全部pending
    # 且超过10分钟没有更新，视为卡住，标记为failed，避免阻塞新的重做请求。
    def _cleanup_stale_rerun_batches(store):
        stale_ids = []
        for rb in (store.get('rerun_batches') or []):
            if rb.get('batch_id') != batch_id or rb.get('status') not in {'running', 'resuming'}:
                continue
            rb_items = rb.get('items') or []
            all_done = all(
                (it.get('status') or '') in {'accepted', 'failed', 'skipped'}
                for it in rb_items
            )
            all_pending = all((it.get('status') or '') == 'pending' for it in rb_items)
            updated_at = rb.get('updated_at') or rb.get('created_at') or ''
            try:
                last_update = datetime.fromisoformat(updated_at) if updated_at else None
                stale = (all_done or all_pending) and (
                    not last_update or (datetime.now() - last_update).total_seconds() > 600
                )
            except (ValueError, TypeError):
                stale = bool(all_done or all_pending)
            if stale:
                rb['status'] = 'failed'
                rb['finished_at'] = datetime.now().isoformat(timespec='seconds')
                if not rb.get('error'):
                    rb['error'] = '批次中断（应用重启或超时）'
                stale_ids.append(rb.get('id'))
                logger.info(f'[ecommerce-rerun-batch] 清理卡住的重做批次: {rb.get("id")} (all_done={all_done}, all_pending={all_pending})')
        return stale_ids
    with ecommerce_lock:
        store = _ecommerce_load_store()
        stale_cleaned = _cleanup_stale_rerun_batches(store)
        if stale_cleaned:
            _ecommerce_save_store(store)

    # 递交重做时，立即移走所有被标记为软删除的废片文件到回收站。
    # 这样用户点击"开始重做"的那一刻，原目录中的废片就消失了，
    # 新图生成后补回原位置，对比界面不会新旧混杂。
    total_recycled = 0
    total_failed = 0
    recycled_by_garment = {}  # (garment_id, action_order) -> count
    for item in items:
        if item.get('status') != 'pending':
            continue
        gid = item.get('garment_id')
        action_order = int(item.get('action_order') or 0)
        if not gid or not action_order:
            continue
        garment = _ecommerce_find_garment(batch, gid)
        if not garment:
            continue
        # 重新读取最新的batch快照（因为上一次循环可能修改了batch）
        batch = _ecommerce_batch_snapshot(batch_id)
        rc, fc = _ecommerce_recycle_soft_deleted_for_action(batch, garment, action_order)
        total_recycled += rc
        total_failed += fc
        if rc > 0:
            recycled_by_garment[(gid, action_order)] = rc
    if total_recycled > 0:
        logger.info(f'[ecommerce-rerun-batch] 创建批次时移走软删除文件: {total_recycled}个成功, {total_failed}个失败')
        # 移走文件后重新读取batch，确保后续使用最新数据
        batch = _ecommerce_batch_snapshot(batch_id)

    now = datetime.now().isoformat(timespec='seconds')
    row = {
        'id': gen_id('ecrbatch'), 'batch_id': batch_id,
        'name': str(body.get('name') or f"废片重做 {datetime.now().strftime('%m-%d %H:%M')}").strip(),
        'status': 'running', 'settings': dict(body.get('settings') or {}),
        'items': items, 'created_at': now, 'updated_at': now,
        'started_at': now, 'finished_at': '', 'legacy_recovered': False,
    }
    _ecommerce_refresh_rerun_batch_counts(row)
    with ecommerce_lock:
        store = _ecommerce_load_store()
        store.setdefault('rerun_batches', []).append(row)
        store['rerun_batches'] = store['rerun_batches'][-100:]
        _ecommerce_save_store(store)
    return jsonify({'ok': True, 'rerun_batch': _ecommerce_rerun_batch_summary(row, include_items=True)}), 201


@app.route('/api/ecommerce/rerun-batches/recover-latest', methods=['POST'])
def ecommerce_recover_latest_rerun_batch():
    """把旧版浏览器刷新前已完成的重做结果与当前未完成项合并为可恢复批次。"""
    body = request.get_json(silent=True) or {}
    batch_id = str(body.get('batch_id') or '')
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到原始批次'}), 404
    with ecommerce_lock:
        existing = [row for row in _ecommerce_load_store().get('rerun_batches') or [] if row.get('batch_id') == batch_id]
    if existing:
        latest = sorted(existing, key=lambda row: row.get('created_at') or '')[-1]
        return jsonify({'ok': True, 'created': False, 'rerun_batch': _ecommerce_rerun_batch_summary(latest, include_items=True)})
    attempts = []
    task_by_id = {task.get('id'): task for task in batch.get('tasks') or []}
    for task in batch.get('tasks') or []:
        for attempt in task.get('attempts') or []:
            path = attempt.get('archived_path') or ''
            if attempt.get('rerun') and path and os.path.isfile(path) and attempt.get('started_at'):
                attempts.append((attempt.get('started_at'), task, attempt))
    attempts.sort(key=lambda entry: entry[0])
    if not attempts:
        return jsonify({'error': '没有找到可恢复的历史重做结果'}), 404
    # 只取最近一段连续重做；相邻任务超过30分钟视为另一批。
    streak = [attempts[-1]]
    for entry in reversed(attempts[:-1]):
        later = datetime.fromisoformat(streak[-1][0])
        earlier = datetime.fromisoformat(entry[0])
        if (later - earlier).total_seconds() > 1800:
            break
        streak.append(entry)
    streak.reverse()
    accepted_by_item_id = {}
    for _started, task, attempt in streak:
        garment = _ecommerce_find_garment(batch, task.get('garment_id'))
        if not garment:
            continue
        item_id = f"{task.get('garment_id')}-{int(task.get('action_order') or 0) + 1}"
        entry = accepted_by_item_id.setdefault(item_id, {
            'id': str(attempt.get('id') or gen_id('ecritem')), 'item_id': item_id,
            'garment_id': task.get('garment_id'), 'garment_name': garment.get('name') or task.get('garment_name'),
            'action_order': int(task.get('action_order') or 0) + 1,
            'action_name': task.get('action_name') or '', 'status': 'accepted',
            'payload': {}, 'archived_paths': [],
            'started_at': attempt.get('started_at') or '', 'finished_at': attempt.get('finished_at') or '',
        })
        archived_path = attempt.get('archived_path')
        if archived_path and os.path.realpath(archived_path) not in {
            os.path.realpath(path) for path in entry['archived_paths']
        }:
            entry['archived_paths'].append(archived_path)
        entry['finished_at'] = attempt.get('finished_at') or entry.get('finished_at') or ''
    accepted_items = list(accepted_by_item_id.values())
    try:
        pending_items = [_ecommerce_validate_rerun_queue_item(batch, raw) for raw in (body.get('items') or [])[:500]]
    except (ValueError, TypeError) as exc:
        return jsonify({'error': str(exc)}), 400
    accepted_item_ids = {item.get('item_id') for item in accepted_items}
    pending_items = [item for item in pending_items if item.get('item_id') not in accepted_item_ids]
    # 旧版没有保存浏览器队列，但最近一次已完成 attempt 会保存真实模型。
    # 用它恢复平台/模型/比例，避免“继续”时悄悄换回原批次模型。
    latest_signature = dict(streak[-1][2].get('model_signature') or {})
    recovered_model_override = {
        'platform': latest_signature.get('platform') or '',
        'model_key': latest_signature.get('model_key') or '',
        'aspect_ratio': latest_signature.get('aspect_ratio') or 'auto',
    }
    if recovered_model_override['platform'] and recovered_model_override['model_key']:
        for item in pending_items:
            item.setdefault('payload', {})['model_override'] = dict(recovered_model_override)
    now = datetime.now().isoformat(timespec='seconds')
    recovered_settings = dict(body.get('settings') or {})
    recovered_settings.update({
        'concurrency': 1,  # 旧版并发无法可靠还原，安全地按1继续
        'platform': recovered_model_override.get('platform') or recovered_settings.get('platform'),
        'modelKey': recovered_model_override.get('model_key') or recovered_settings.get('modelKey'),
        'ratio': recovered_model_override.get('aspect_ratio') or recovered_settings.get('ratio') or 'auto',
        'prompt_recovered': False,
    })
    row = {
        'id': gen_id('ecrbatch'), 'batch_id': batch_id,
        'name': f"恢复的废片重做 {datetime.now().strftime('%m-%d %H:%M')}",
        'status': 'interrupted', 'settings': recovered_settings,
        'items': accepted_items + pending_items, 'created_at': streak[0][0],
        'updated_at': now, 'started_at': streak[0][0], 'finished_at': '',
        'legacy_recovered': True,
    }
    _ecommerce_refresh_rerun_batch_counts(row)
    if pending_items:
        row['status'] = 'interrupted'
    with ecommerce_lock:
        store = _ecommerce_load_store()
        store.setdefault('rerun_batches', []).append(row)
        _ecommerce_save_store(store)
    return jsonify({'ok': True, 'created': True, 'rerun_batch': _ecommerce_rerun_batch_summary(row, include_items=True)})


@app.route('/api/ecommerce/rerun-batches/<rerun_batch_id>', methods=['GET'])
def ecommerce_get_rerun_batch(rerun_batch_id):
    row = _ecommerce_rerun_batch_snapshot(rerun_batch_id)
    if not row:
        return jsonify({'error': '找不到重做批次'}), 404
    return jsonify({'rerun_batch': _ecommerce_rerun_batch_summary(row, include_items=True)})


@app.route('/api/ecommerce/rerun-batches/<rerun_batch_id>/action', methods=['POST'])
def ecommerce_rerun_batch_action(rerun_batch_id):
    body = request.get_json(silent=True) or {}
    action = str(body.get('action') or '').lower()
    row = _ecommerce_rerun_batch_snapshot(rerun_batch_id)
    if not row:
        return jsonify({'error': '找不到重做批次'}), 404
    if action == 'pause':
        _ecommerce_mutate_rerun_batch(rerun_batch_id, lambda item: item.update({'status': 'paused'}))
    elif action == 'resume':
        def resume(item):
            item['status'] = 'running'
            for task in item.get('items') or []:
                if task.get('status') in {'failed', 'partial'}:
                    task['status'] = 'pending'
                    task['error'] = ''
                elif task.get('status') == 'running':
                    # 进程身份不同表示热重载/重启已经杀掉旧本地请求；平台 taskId
                    # 仍保存在原批次 attempt 中，放回 pending 后会只查询原任务。
                    if task.get('worker_id') != ECOMMERCE_PROCESS_ID:
                        task['status'] = 'pending'
                        task['recovery_pending'] = True
                        task['error'] = '正在接回应用重启前已提交的平台任务，不会重复扣费'
                        task['worker_id'] = ''
                        continue
                    # 页面刷新不会取消仍在服务端执行的请求。只回收已经超过
                    # 单次请求最长等待时间的陈旧任务，避免立即继续时重复扣费。
                    try:
                        started_at = datetime.fromisoformat(task.get('started_at') or '')
                    except (TypeError, ValueError):
                        started_at = None
                    if started_at and (datetime.now() - started_at).total_seconds() > 12 * 60:
                        task['status'] = 'pending'
                        task['error'] = '上次请求已超过12分钟，已安全放回待处理队列'
                        task['recovery_pending'] = True
        _ecommerce_mutate_rerun_batch(rerun_batch_id, resume)
        # 恢复批次时，也要立即移走所有待处理项对应的软删除文件
        # （处理用户在批次失败后新标记的废片）
        updated_row = _ecommerce_rerun_batch_snapshot(rerun_batch_id)
        if updated_row:
            batch_id = updated_row.get('batch_id')
            batch = _ecommerce_batch_snapshot(batch_id) if batch_id else None
            if batch:
                recycled_total = 0
                for item in (updated_row.get('items') or []):
                    if item.get('status') != 'pending':
                        continue
                    gid = item.get('garment_id')
                    garment = _ecommerce_find_garment(batch, gid) if gid else None
                    if not garment:
                        continue
                    batch = _ecommerce_batch_snapshot(batch_id)
                    rc, _fc = _ecommerce_recycle_soft_deleted_for_action(batch, garment, int(item.get('action_order') or 0))
                    recycled_total += rc
                if recycled_total > 0:
                    logger.info(f'[ecommerce-rerun-resume] 恢复批次时移走软删除文件: {recycled_total}个')
    elif action == 'finalize':
        _ecommerce_mutate_rerun_batch(rerun_batch_id, lambda item: item.update({
            'status': 'partial' if int(item.get('completed_count') or 0) < int(item.get('total_count') or 0) else 'completed',
            'finished_at': datetime.now().isoformat(timespec='seconds'),
        }))
    else:
        return jsonify({'error': '不支持的重做批次操作'}), 400
    updated = _ecommerce_rerun_batch_snapshot(rerun_batch_id)
    return jsonify({'ok': True, 'rerun_batch': _ecommerce_rerun_batch_summary(updated, include_items=True)})


@app.route('/api/ecommerce/rerun-batches/<rerun_batch_id>/garments/<garment_id>/compare', methods=['GET'])
def ecommerce_rerun_batch_compare(rerun_batch_id, garment_id):
    row = _ecommerce_rerun_batch_snapshot(rerun_batch_id)
    if not row:
        return jsonify({'error': '找不到重做批次'}), 404
    batch = _ecommerce_batch_snapshot(row.get('batch_id'))
    garment = _ecommerce_find_garment(batch, garment_id) if batch else None
    if not garment:
        return jsonify({'error': '找不到服装'}), 404
    payload = _ecommerce_group_compare_payload(batch, garment)
    allowed = {
        os.path.realpath(path)
        for item in row.get('items') or [] if item.get('status') in {'accepted', 'partial'} and item.get('garment_id') == garment_id
        for path in item.get('archived_paths') or [] if path
    }
    payload['results'] = [
        result for result in payload.get('results') or []
        if os.path.realpath(result.get('path') or '') in allowed
        or os.path.realpath(result.get('original_path') or '') in allowed
    ]
    allowed_result_paths = {
        os.path.realpath(result.get('path') or result.get('original_path') or '')
        for result in payload['results']
    }
    filtered_action_groups = []
    for action_group in payload.get('action_groups') or []:
        action_group['results'] = [
            result for result in action_group.get('results') or []
            if os.path.realpath(result.get('path') or result.get('original_path') or '') in allowed_result_paths
        ]
        if action_group['results']:
            action_group['original_count'] = len(action_group['results'])
            action_group['kept_count'] = len([result for result in action_group['results'] if not result.get('is_deleted')])
            action_group['deleted_count'] = len([result for result in action_group['results'] if result.get('is_deleted')])
            action_group['marked_count'] = len([result for result in action_group['results'] if result.get('is_marked_redo')])
            filtered_action_groups.append(action_group)
    payload['action_groups'] = filtered_action_groups
    payload['rerun_batch_id'] = rerun_batch_id
    payload['rerun_batch_name'] = row.get('name') or rerun_batch_id
    if not payload['results']:
        return jsonify({'error': '这个重做批次在该套服装下没有可验收图片'}), 409
    return jsonify(payload)


def _ecommerce_resumable_rerun_attempt(
    batch, task_id, sample_number, rerun_total,
    source_deletion_ids=None, source_mark_id='', expected_operation_id='',
):
    """Return a paid provider task that was submitted but not locally archived.

    The identity check is deliberately strict.  A stale attempt for another
    deleted image or marked-redo event must never be attached to this rerun.
    """
    task = _ecommerce_find_task(batch, task_id)
    wanted_deletions = sorted(str(value) for value in (source_deletion_ids or []) if value)
    wanted_mark = str(source_mark_id or '')
    for attempt in reversed((task or {}).get('attempts') or []):
        if not attempt.get('rerun') or not attempt.get('request_id'):
            continue
        if attempt.get('archived_path') and os.path.isfile(attempt.get('archived_path')):
            continue
        if int(attempt.get('rerun_sample') or 0) != int(sample_number):
            continue
        if int(attempt.get('rerun_total') or 0) != int(rerun_total):
            continue
        if expected_operation_id and attempt.get('rerun_operation_id') != expected_operation_id:
            continue
        attempt_deletions = sorted(str(value) for value in attempt.get('source_deletion_ids') or [] if value)
        if attempt_deletions != wanted_deletions:
            continue
        if str(attempt.get('source_mark_id') or '') != wanted_mark:
            continue
        if str(attempt.get('provider') or '') != 'runninghub':
            continue
        return dict(attempt)
    return None


@app.route('/api/ecommerce/regenerate', methods=['POST'])
def ecommerce_regenerate():
    """废片重做：对指定服装+动作重新生成一张，归档回原 AI 结果目录。

    支持提示词覆盖和参考图覆盖（仅本次重做，不改原服装文件夹）。
    """
    body = request.get_json(silent=True) or {}
    requested_count = max(1, min(int(body.get('count') or 1), 5))
    batch_id = str(body.get('batch_id') or '')
    item_id = str(body.get('item_id') or '')
    rerun_batch_id = str(body.get('rerun_batch_id') or '')
    requested_deletion_ids = list(dict.fromkeys(
        str(value).strip() for value in list(body.get('deletion_ids') or [])[:5]
        if str(value or '').strip()
    ))
    mark_id = str(body.get('mark_id') or '').strip()
    marked_result_path = str(body.get('marked_result_path') or '').strip()
    marked_result_real = os.path.realpath(os.path.expanduser(marked_result_path)) if marked_result_path else ''
    marked_request = '-marked-' in item_id or item_id.endswith('-marked')
    prompt_override = str(body.get('prompt') or '').strip()
    rerun_mode = str(body.get('mode') or 'full').strip().lower()
    rerun_operation_id = gen_id('ecrerun')
    if rerun_mode not in {'full', 'detail_repair'}:
        return jsonify({'error': '不支持的重做模式'}), 400
    reference_overrides = body.get('reference_overrides') or []
    target_action_image = str(body.get('target_action_image') or '').strip()
    model_override = body.get('model_override') or {}
    batch = _ecommerce_batch_snapshot(batch_id)
    if not batch:
        return jsonify({'error': '找不到批次'}), 404
    # 解析 item_id: garment_id-action_order 或 garment_id-action_order-marked
    # （scan-deleted 对标记重做的项会加 -marked 后缀，这里统一去掉）
    clean_item_id = item_id.split('-marked', 1)[0] if '-marked' in item_id else item_id
    try:
        garment_id, action_order_str = clean_item_id.rsplit('-', 1)
        action_order = int(action_order_str)
    except (ValueError, AttributeError):
        return jsonify({'error': f'item_id 格式无效: {item_id}'}), 400
    garment = _ecommerce_find_garment(batch, garment_id)
    if not garment:
        return jsonify({'error': '找不到服装'}), 404
    requested_result_path = str(body.get('result_path') or '').strip()
    expected_result_path = _ecommerce_sample_result_dir(batch, garment)
    if requested_result_path:
        requested_result_path = os.path.realpath(os.path.expanduser(requested_result_path))
        if requested_result_path != os.path.realpath(expected_result_path):
            return jsonify({'error': '重做结果目录与该废片原AI结果目录不一致，请重新扫描废片后再提交'}), 409
    actions = _ecommerce_actions_for_garment(batch, garment)
    action = next((a for a in actions if int(a.get('order') or 0) == action_order - 1), None)
    if not action:
        return jsonify({'error': '找不到动作'}), 404
    # 找到对应任务（可能已完成）
    task = next((t for t in batch.get('tasks', []) if t.get('garment_id') == garment_id and int(t.get('action_order') or 0) == action_order - 1), None)
    if not task:
        return jsonify({'error': '找不到任务'}), 404
    active_deletions = sorted((
        row for row in batch.get('deleted_samples') or []
        if row.get('garment_id') == garment_id
        and int(row.get('action_order') or 0) == action_order
        and row.get('status') in {'deleted', 'pending'}
    ), key=lambda row: row.get('deleted_at') or '')
    active_deletion_ids = [str(row.get('id') or '') for row in active_deletions if row.get('id')]
    # 新客户端精确指定本次要补的删除事件。旧客户端没有 deletion_ids 时，
    # 冻结请求开始时的活动缺口，仍保持兼容，但后续抽卡不能越界结清新缺口。
    source_deletion_ids = (
        [value for value in requested_deletion_ids if value in active_deletion_ids]
        if requested_deletion_ids else active_deletion_ids
    )
    # 递交重做时软删除文件已在创建rerun-batch时移走（_ecommerce_recycle_soft_deleted_for_action）。
    # 这里作为双重保险，处理重试场景或直接调用regenerate API的情况，再次确保软删除文件已移走。
    _ecommerce_recycle_soft_deleted_for_action(batch, garment, action_order)
    # 重新读取batch快照（移走文件后台账已更新）
    batch = _ecommerce_batch_snapshot(batch_id)
    rerun_queue_item = None
    expected_rerun_operation_id = ''
    cached_paths = []
    if rerun_batch_id:
        rerun_batch = _ecommerce_rerun_batch_snapshot(rerun_batch_id)
        if not rerun_batch or rerun_batch.get('batch_id') != batch_id:
            return jsonify({'error': '重做批次与原始批次不匹配'}), 409
        rerun_queue_item = next((entry for entry in rerun_batch.get('items') or [] if entry.get('item_id') == item_id), None)
        if not rerun_queue_item:
            return jsonify({'error': '这张废片不属于当前重做批次'}), 409
        expected_rerun_operation_id = str(rerun_queue_item.get('rerun_operation_id') or '')
        if expected_rerun_operation_id:
            rerun_operation_id = expected_rerun_operation_id
        requested_count = max(1, min(int(
            (rerun_queue_item.get('payload') or {}).get('count')
            or rerun_queue_item.get('requested_count')
            or requested_count
        ), 5))
        cached_paths = [path for path in rerun_queue_item.get('archived_paths') or [] if os.path.isfile(path)]
        if rerun_queue_item.get('status') == 'accepted' and len(cached_paths) >= requested_count:
            return jsonify({
                'ok': True, 'cached': True, 'archived_path': cached_paths[0],
                'archived_list': cached_paths, 'success_count': len(cached_paths),
                'total_count': requested_count, 'remaining_count': 0,
                'rerun_batch_id': rerun_batch_id,
            })
        if rerun_batch.get('status') not in {'running', 'resuming'}:
            return jsonify({'error': '重做批次当前未运行，请先点击继续'}), 409
        if rerun_queue_item.get('status') == 'running':
            return jsonify({'error': '该废片已经在后台重做，请等待返回后刷新'}), 409
    # 构建可覆盖参考图的 garment 副本
    garment_copy = dict(garment)
    images = list(garment.get('images') or [])
    reference_images = body.get('reference_images')
    generation_mode = _ecommerce_generation_mode(batch, garment)
    # 重做队列旧版本可能没有持久化 target_action_image。对换装模式必须
    # 使用原批次冻结的动作参考图，绝不能退回生成结果/废片备份作为目标图。
    if generation_mode == 'garment_reference' and not target_action_image:
        target_action_image = str(action.get('action_image') or '').strip()
    if generation_mode in {'target_only', 'garment_prompt'}:
        # scan-deleted 会把原目标图返回给前端作左右对比，但它不是
        # 第二张生图参考。重做仍只由 action_copy.action_image 提交一次。
        garment_copy['images'] = []
    elif isinstance(reference_images, list):
        try:
            selected_images = [_ecommerce_resolve_rerun_reference(source) for source in reference_images[:10] if str(source or '').strip()]
        except ValueError as exc:
            return jsonify({'error': f'重做参考图无效: {exc}'}), 400
        if not selected_images:
            return jsonify({'error': '请至少选择一张服装参考图'}), 400
        garment_copy['images'] = selected_images
    # reference_overrides 是 6 个元素的列表，空字符串表示用原图
    elif isinstance(reference_overrides, list) and len(reference_overrides) in {6, 10}:
        # overrides 里存的是 local-image URL，需要还原成本地路径
        new_images = []
        for i, override in enumerate(reference_overrides):
            if override and i < len(images):
                parsed = parse_qs(urlparse(override).query)
                path_list = parsed.get('path', [])
                if path_list and os.path.isfile(path_list[0]):
                    new_images.append(path_list[0])
                else:
                    new_images.append(images[i])
            elif i < len(images):
                new_images.append(images[i])
        garment_copy['images'] = new_images
    try:
        action_copy = _ecommerce_apply_rerun_model(action, model_override)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    if (batch.get('settings') or {}).get('precision_matching') and generation_mode == 'garment_reference':
        # 精准模式重做仍必须遵守原批次的动作→服装序号映射；不能因为重做界面
        # 传入整套参考图而退回“全部参考图提交”。如果用户明确选择了重做参考图，
        # 则把它视为本次唯一参考图并把序号归零。
        if isinstance(reference_images, list) and reference_images:
            action_copy['garment_reference_index'] = 0
        else:
            reference_index = int(action.get('garment_reference_index') if action.get('garment_reference_index') is not None else -1)
            if 0 <= reference_index < len(images):
                garment_copy['images'] = [images[reference_index]]
                action_copy['garment_reference_index'] = 0
            else:
                garment_copy['images'] = []
                action_copy['garment_reference_index'] = -1
    if target_action_image and rerun_mode == 'detail_repair':
        return jsonify({'error': '细节修复使用废片本身作为目标图，不能同时替换动作参考图'}), 400
    if target_action_image:
        try:
            action_copy['action_image'] = _ecommerce_resolve_rerun_reference(target_action_image)
        except ValueError as exc:
            return jsonify({'error': f'动作参考图无效: {exc}'}), 400
    if rerun_mode == 'detail_repair':
        repair_source = _ecommerce_find_rerun_source(batch, task, garment, action_order)
        if not repair_source:
            return jsonify({'error': '找不到这张废片的本地备份，无法进行细节修复；请改用整图重做'}), 409
        action_copy['action_image'] = repair_source
        prompt = _ecommerce_detail_repair_prompt(prompt_override)
    else:
        prompt = _ecommerce_rerun_prompt(action.get('prompt'), prompt_override)
        # 旧版批次数据可能未持久化 action_image，导致 KeyError。
        # 从 task 的已接受结果或废片备份中恢复一张可用图片作为目标参考图。
        if not str(action_copy.get('action_image') or '').strip():
            fallback_source = _ecommerce_find_rerun_source(batch, task, garment, action_order)
            if not fallback_source:
                return jsonify({'error': '找不到原始目标参考图，请改用细节修复模式重做'}), 409
            action_copy['action_image'] = fallback_source
            logger.info(f'[ecommerce-regenerate] action_image 缺失，使用 fallback: {fallback_source}')
    if rerun_batch_id:
        def mark_rerun_running(row):
            entry = next((item for item in row.get('items') or [] if item.get('item_id') == item_id), None)
            if entry:
                entry.update({
                    'status': 'running',
                    'started_at': datetime.now().isoformat(timespec='seconds'),
                    'error': '', 'worker_id': ECOMMERCE_PROCESS_ID,
                    'recovery_pending': False,
                })
                if not entry.get('rerun_operation_id'):
                    entry['rerun_operation_id'] = rerun_operation_id
            _ecommerce_refresh_rerun_batch_counts(row)
        _ecommerce_mutate_rerun_batch(rerun_batch_id, mark_rerun_running)
    attempt = {
        'id': f'{rerun_operation_id}-1',
        'number': 99,
        'status': 'preparing',
        'request_id': '',
        'candidate_path': '',
        'qc': None,
        'started_at': datetime.now().isoformat(timespec='seconds'),
        'sample': True,
        'rerun': True,
        'rerun_mode': rerun_mode,
    }
    # 抽卡数量是这个重做任务的严格合约：设置3张就必须得到3张。
    # 已归档的部分成功结果会被保留，重试只补剩余张数，不会重复扣费。
    rerun_count = requested_count
    # 确定本次重做的文件命名类型和FP轮次
    result_dir = _ecommerce_sample_result_dir(batch, garment)
    if marked_request:
        # 标记重做：使用BJ类型，不需要FP轮次
        archive_gen_type = 'bj'
        archive_fp_round = 0
    else:
        # 部分成功后的续传必须沿用同一FP轮次，否则同一次抽卡会被误分成两轮。
        cached_identity = _ecommerce_sample_identity(cached_paths[0]) if cached_paths else {}
        archive_fp_round = int(cached_identity.get('fp_round') or 0)
        if archive_fp_round <= 0:
            archive_fp_round = _ecommerce_next_fp_round(result_dir, action_order)
        archive_gen_type = 'fp_ck' if rerun_count > 1 else 'fp'
    # 低价渠道等不稳定平台会出现偶发失败（任务报错、超时、网络抖动等），
    # 这里复用批量生成的重试策略：最多3次尝试，指数退避（3s/6s/12s）。
    # 配置类错误（API Key 未配置等）和用户主动暂停不重试。
    ECOMMERCE_RERUN_MAX_ATTEMPTS = 3
    archived_list = list(cached_paths)
    history_path_list = []
    last_error = ''
    existing_count = len(archived_list)
    for sample_number in range(existing_count + 1, rerun_count + 1):
        candidate = None
        attempt = None
        for rerun_try in range(ECOMMERCE_RERUN_MAX_ATTEMPTS):
            # 同一张图的重试必须沿用同一个 attempt。只要已有 request_id，
            # _ecommerce_generate_candidate 就会继续轮询原任务，不会再次 submit。
            resumable_attempt = None
            if attempt is None:
                resumable_attempt = _ecommerce_resumable_rerun_attempt(
                    _ecommerce_batch_snapshot(batch['id']), task['id'], sample_number,
                    rerun_count, source_deletion_ids, mark_id,
                    expected_operation_id=expected_rerun_operation_id,
                )
                attempt = dict(resumable_attempt) if resumable_attempt else {
                    'id': f'{rerun_operation_id}-{sample_number}',
                    'number': 99,
                    'status': 'preparing',
                    'request_id': '',
                    'candidate_path': '',
                    'qc': None,
                    'started_at': datetime.now().isoformat(timespec='seconds'),
                    'sample': True,
                    'rerun': True,
                    'rerun_mode': rerun_mode,
                    'rerun_sample': sample_number,
                    'rerun_total': rerun_count,
                    'rerun_operation_id': rerun_operation_id,
                    'source_deletion_ids': list(source_deletion_ids),
                    'source_mark_id': mark_id,
                }
            attempt['rerun_attempt'] = rerun_try + 1
            if resumable_attempt:
                rerun_operation_id = str(attempt.get('rerun_operation_id') or rerun_operation_id)
                expected_rerun_operation_id = rerun_operation_id
                attempt['status'] = 'resuming'
                logger.info(
                    '[ecommerce-regenerate] 接回已提交任务，不重复扣费: item=%s sample=%s taskId=%s',
                    item_id, sample_number, attempt.get('request_id')
                )
                if rerun_batch_id:
                    def remember_operation(row):
                        entry = next((value for value in row.get('items') or [] if value.get('item_id') == item_id), None)
                        if entry:
                            entry['rerun_operation_id'] = rerun_operation_id
                            entry['recovery_pending'] = False
                    _ecommerce_mutate_rerun_batch(rerun_batch_id, remember_operation)
            try:
                candidate = _ecommerce_generate_candidate(batch, task, garment_copy, action_copy, prompt, attempt)
                if candidate and os.path.isfile(candidate):
                    break
                last_error = '生成失败：未返回图片'
            except InterruptedError:
                return jsonify({'error': '批次已暂停/取消'}), 409
            except Exception as exc:
                last_error = str(exc)
                logger.warning(f'[ecommerce-regenerate] 第{sample_number}张 第{rerun_try + 1}次尝试失败: {last_error}')
                if _ecommerce_generation_needs_configuration(last_error) or isinstance(exc, PermissionError):
                    break
                if attempt.get('submission_uncertain'):
                    # 没有 taskId 时无法安全确认供应商是否已经受理，禁止重复扣费式重投。
                    break
                if rerun_try < ECOMMERCE_RERUN_MAX_ATTEMPTS - 1:
                    backoff = 3 * (2 ** rerun_try)
                    logger.info(f'[ecommerce-regenerate] 第{sample_number}张 {backoff}秒后重试 ({rerun_try + 2}/{ECOMMERCE_RERUN_MAX_ATTEMPTS})')
                    time.sleep(backoff)
        if not candidate or not os.path.isfile(candidate):
            # 部分成功不能验收。保留已成功文件，记为partial，让客户端只重试缺少的张数。
            if rerun_batch_id:
                def mark_rerun_failed(row):
                    entry = next((item for item in row.get('items') or [] if item.get('item_id') == item_id), None)
                    if entry:
                        entry.update({
                            'status': 'partial' if archived_list else 'failed',
                            'archived_paths': list(archived_list),
                            'requested_count': rerun_count,
                            'success_count': len(archived_list),
                            'remaining_count': max(0, rerun_count - len(archived_list)),
                            'error': last_error,
                            'finished_at': datetime.now().isoformat(timespec='seconds'),
                        })
                    _ecommerce_refresh_rerun_batch_counts(row)
                _ecommerce_mutate_rerun_batch(rerun_batch_id, mark_rerun_failed)
            return jsonify({
                'error': f'第{sample_number}张重做失败（已重试{ECOMMERCE_RERUN_MAX_ATTEMPTS}次）：{last_error}',
                'partial': bool(archived_list),
                'archived_list': archived_list,
                'success_count': len(archived_list),
                'total_count': rerun_count,
                'remaining_count': max(0, rerun_count - len(archived_list)),
                'rerun_batch_id': rerun_batch_id,
            }), 503
        previous_source = _ecommerce_find_rerun_source(batch, task, garment, action_order)
        history_path = ''
        if previous_source and os.path.isfile(previous_source):
            history_dir = os.path.join(
                os.path.expanduser(batch.get('output_path') or ''), '_重做历史',
                _ecommerce_safe_name(garment.get('name') or garment_id, garment_id),
            )
            try:
                os.makedirs(history_dir, exist_ok=True)
                previous_ext = os.path.splitext(previous_source)[1] or '.jpg'
                history_path = os.path.join(
                    history_dir,
                    f"{batch.get('run_code') or 'RUN'}-AI-{action_order:02d}-{rerun_mode}-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{sample_number}{previous_ext}",
                )
                shutil.copy2(previous_source, history_path)
            except Exception as exc:
                logger.warning(f'[ecommerce-rerun] 保存历史副本失败: {exc}')
        history_path_list.append(history_path)
        result_model = _ecommerce_action_model_signature(action_copy)
        original_model = _ecommerce_action_model_signature(action)
        model_changed = result_model.get('key') != original_model.get('key')
        if model_changed:
            rerun_code = '-'.join(_ecommerce_run_code_parts(action_copy))
        else:
            rerun_code = batch.get('run_code') or '-'.join(_ecommerce_run_code_parts(action_copy))
        result_model['run_code'] = rerun_code
        # 使用新命名规则归档：
        # - 废片重做单张 → FP轮次-01
        # - 废片重做抽卡 → FP轮次-CK序号
        # - 标记重做 → BJ序号
        archived = _ecommerce_archive_sample(
            batch, task, candidate, sample_number, rerun_count,
            run_code_override=rerun_code,
            gen_type=archive_gen_type,
            fp_round=archive_fp_round,
        )
        archived_list.append(archived)
        attempt['candidate_path'] = candidate
        attempt['archived_path'] = archived
        attempt['status'] = 'archived'
        attempt['model_signature'] = result_model
        def store_rerun_result(stored_batch):
            _ecommerce_sync_attempt(stored_batch, task['id'], attempt)
            stored_task = _ecommerce_find_task(stored_batch, task['id'])
            if stored_task is not None:
                stored_task['result_model'] = result_model
                # 更新 accepted_path 为第一张新生成的图片，前端刷新后能看到最新结果。
                # 抽卡模式后续样本（sample_number > 1）作为候选保留，不覆盖主结果。
                if sample_number == 1 and archived and os.path.isfile(archived):
                    stored_task['accepted_path'] = archived
                    stored_task['state'] = 'accepted'
                    stored_task['result_path'] = archived
                    stored_task['last_error'] = ''
            # 只清理本次真正重做的那一张标记图。删除废片的补做
            # 不得顺带清除同动作的其他手动标记。
            marked = stored_batch.get('marked_redo') or []
            if marked and marked_request and sample_number == rerun_count:
                def is_completed_mark(mark):
                    if mark.get('garment_id') != garment_id or int(mark.get('action_order') or 0) != action_order:
                        return False
                    if mark_id:
                        return mark.get('id') == mark_id
                    if marked_result_real:
                        return os.path.realpath(os.path.expanduser(mark.get('result_path') or '')) == marked_result_real
                    return not mark.get('result_path')
                stored_batch['marked_redo'] = [
                    m for m in marked
                    if not is_completed_mark(m)
                ]
            source_rows = [
                row for row in stored_batch.get('deleted_samples') or []
                if str(row.get('id') or '') in source_deletion_ids
                and row.get('garment_id') == garment_id
                and int(row.get('action_order') or 0) == action_order
            ]
            # 同一次抽卡产生的所有图片都属于这些删除缺口的候选集合，
            # 但第 N 张成功结果最多只结清第 N 个明确缺口。
            for source_row in source_rows:
                candidates = source_row.setdefault('replacement_candidates', [])
                if archived not in candidates:
                    candidates.append(archived)
                source_row['rerun_operation_id'] = rerun_operation_id
            resolved = next((
                row for row in source_rows
                if source_deletion_ids.index(str(row.get('id') or '')) == sample_number - 1
                and row.get('status') in {'deleted', 'pending'}
            ), None)
            if resolved:
                resolved['status'] = 'replaced'
                resolved['replaced_at'] = datetime.now().isoformat(timespec='seconds')
                resolved['replacement_path'] = archived
                resolved_original = os.path.realpath(os.path.expanduser(resolved.get('original_path') or ''))
                if resolved_original:
                    stored_batch['marked_redo'] = [
                        mark for mark in stored_batch.get('marked_redo') or []
                        if not (
                            mark.get('garment_id') == garment_id
                            and os.path.realpath(os.path.expanduser(mark.get('result_path') or '')) == resolved_original
                        )
                    ]
        _ecommerce_mutate_batch(batch['id'], store_rerun_result)
        if marked_request and sample_number == rerun_count and marked_result_real:
            _ecommerce_set_result_asset_status(batch['id'], garment_id, marked_result_real, 'active')
        try:
            # 轻量预览：用于废片对比时加载更快；全分辨率备份已移除，
            # 恢复依赖回收站（.样片工厂废片回收站）。
            preview_path = _ecommerce_task_preview_path(batch, task)
            os.makedirs(os.path.dirname(preview_path), exist_ok=True)
            with Image.open(candidate) as source_image:
                preview = ImageOps.exif_transpose(source_image).convert('RGB')
                if max(preview.size) > 1800:
                    scale = 1800 / max(preview.size)
                    preview = preview.resize((max(1, int(preview.width * scale)), max(1, int(preview.height * scale))), Image.LANCZOS)
                preview.save(preview_path, 'JPEG', quality=86, optimize=True)
        except Exception as exc:
            logger.warning(f'[ecommerce-regenerate] 更新预览失败: {exc}')
        logger.info(f'[ecommerce-regenerate] 第{sample_number}/{rerun_count}张重做完成: {archived}')
    # 使用第一张的 rerun_code 作为返回值
    final_archived = archived_list[0] if archived_list else ''
    final_history = history_path_list[0] if history_path_list else ''
    final_result_model = result_model if archived_list else {}
    logger.info(f'[ecommerce-regenerate] 重做完成: 共{len(archived_list)}/{rerun_count}张成功')
    if rerun_batch_id and len(archived_list) >= rerun_count:
        def mark_rerun_accepted(row):
            entry = next((item for item in row.get('items') or [] if item.get('item_id') == item_id), None)
            if entry:
                entry.update({
                    'status': 'accepted', 'archived_paths': list(archived_list),
                    'requested_count': rerun_count, 'success_count': len(archived_list),
                    'remaining_count': 0,
                    'finished_at': datetime.now().isoformat(timespec='seconds'), 'error': '',
                    'model_signature': final_result_model,
                })
            _ecommerce_refresh_rerun_batch_counts(row)
        _ecommerce_mutate_rerun_batch(rerun_batch_id, mark_rerun_accepted)
    return jsonify({
        'ok': True,
        'archived_path': final_archived,
        'archived_list': archived_list,
        'history_path': final_history,
        'mode': rerun_mode,
        'rerun_code': rerun_code if archived_list else '',
        'model_signature': final_result_model,
        'success_count': len(archived_list),
        'total_count': rerun_count,
        'remaining_count': max(0, rerun_count - len(archived_list)),
        'rerun_batch_id': rerun_batch_id,
    })


# ─── 电商换装提示词模板 API ──────────────────────────────
def _ecommerce_clean_prompt_template_store(body):
    templates = body.get('templates', [])
    snippets = body.get('snippets', [])
    if not isinstance(templates, list) or not isinstance(snippets, list):
        raise ValueError('提示词模板数据格式无效')
    clean_templates = []
    used_ids = set()
    for index, row in enumerate(templates[:100]):
        if not isinstance(row, dict):
            continue
        name = str(row.get('name') or '').strip()[:80]
        prompt = str(row.get('prompt') or '').strip()[:30000]
        if not name or not prompt:
            continue
        template_id = str(row.get('id') or '').strip()[:100] or gen_id('ectplprompt')
        if template_id in used_ids:
            template_id = gen_id('ectplprompt')
        used_ids.add(template_id)
        clean_templates.append({'id': template_id, 'name': name, 'prompt': prompt})
    clean_snippets = []
    used_snippet_ids = set()
    for row in snippets[:100]:
        if not isinstance(row, dict):
            continue
        text = str(row.get('text') or '').strip()[:10000]
        if not text:
            continue
        name = str(row.get('name') or text[:12]).strip()[:80] or text[:12]
        snippet_id = str(row.get('id') or '').strip()[:100] or gen_id('ecsnippet')
        if snippet_id in used_snippet_ids:
            snippet_id = gen_id('ecsnippet')
        used_snippet_ids.add(snippet_id)
        clean_row = {'id': snippet_id, 'name': name, 'text': text}
        if str(row.get('position') or '') in {'suffix', 'cursor'}:
            clean_row['position'] = str(row.get('position'))
        clean_snippets.append(clean_row)
    return {'templates': clean_templates, 'snippets': clean_snippets}


@app.route('/api/ecommerce/prompt-templates', methods=['GET'])
def ecommerce_get_prompt_templates():
    """获取电商换装提示词模板列表"""
    data = load_json('ecommerce_prompt_templates.json')
    if data is None or not isinstance(data, dict):
        data = {'templates': [], 'snippets': []}
    if 'templates' not in data:
        data['templates'] = []
    if 'snippets' not in data:
        data['snippets'] = []
    return jsonify(data)


@app.route('/api/ecommerce/prompt-templates', methods=['PUT'])
def ecommerce_update_prompt_templates():
    """保存电商换装提示词模板列表"""
    body = request.get_json(silent=True) or {}
    try:
        cleaned = _ecommerce_clean_prompt_template_store(body)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    with data_lock:
        save_json('ecommerce_prompt_templates.json', cleaned)
    logger.info(f"更新电商提示词模板: {len(cleaned['templates'])}个模板, {len(cleaned['snippets'])}个片段")
    return jsonify({'success': True, **cleaned})


# ─── 图库 API ──────────────────────────────────────────────

def _get_download_base():
    """获取当前配置的下载根目录"""
    config = load_json('model_config.json') or {}
    base = config.get('rh_download_path', '').strip() or '~/Downloads/AI生图/'
    return os.path.realpath(os.path.expanduser(base))


def _collect_gallery_files():
    """收集软件生成(API返图)并已落盘的图片路径。"""
    img_exts = {'.jpg', '.jpeg', '.png', '.webp', '.bmp'}
    material_root = os.path.realpath(IMAGES_DIR)
    dwpose_cache_root = os.path.realpath(DWPOSE_CACHE_DIR)
    material_refs = _collect_material_image_paths()
    files = []
    seen = set()

    def _is_excluded_path(real):
        if real == dwpose_cache_root or real.startswith(dwpose_cache_root + os.sep):
            return True
        return real in material_refs

    def _add_file(path_value):
        if not path_value or not isinstance(path_value, str):
            return
        real = os.path.realpath(os.path.expanduser(path_value.strip()))
        safe = _safe_path(real)
        if not safe or _is_excluded_path(safe):
            return
        if not os.path.isfile(safe):
            return
        if os.path.splitext(safe)[1].lower() not in img_exts:
            return
        if safe in seen:
            return
        seen.add(safe)
        files.append(safe)

    def _add_from_url(candidate):
        if not candidate or not isinstance(candidate, str):
            return
        text = candidate.strip()
        if not text:
            return
        if text.startswith('/api/gallery-image?'):
            try:
                from urllib.parse import parse_qs, urlparse, unquote
                q = parse_qs(urlparse(text).query or '')
                p = (q.get('path') or [''])[0]
                if p:
                    _add_file(unquote(p))
            except Exception:
                return
        elif text.startswith('/') or text.startswith('~'):
            _add_file(text)

    def _walk(node):
        if isinstance(node, dict):
            _add_file(node.get('path', ''))
            _add_from_url(node.get('url', ''))
            _add_from_url(node.get('local_url', ''))
            _add_from_url(node.get('localUrl', ''))
            for v in node.values():
                if isinstance(v, (dict, list)):
                    _walk(v)
        elif isinstance(node, list):
            for item in node:
                if isinstance(item, (dict, list)):
                    _walk(item)

    queue_data = load_json('queue_data.json') or {}
    split_data = load_json('split_queue_data.json') or {}
    _walk(queue_data.get('queues') or [])
    _walk(split_data.get('queues') or [])

    # 兜底只扫描下载目录：图库展示最终落盘结果，不把 static/images 里的参考图/裁剪源图混进来。
    scan_bases = {_get_download_base()}
    for q in (queue_data.get('queues') or []):
        if isinstance(q, dict):
            p = (q.get('downloadPath') or '').strip()
            if p:
                scan_bases.add(os.path.realpath(os.path.expanduser(p)))
    for q in (split_data.get('queues') or []):
        if isinstance(q, dict):
            p = (q.get('downloadPath') or '').strip()
            if p:
                scan_bases.add(os.path.realpath(os.path.expanduser(p)))

    for base in scan_bases:
        safe_base = _safe_path(base)
        if not safe_base or not os.path.isdir(safe_base) or _is_excluded_path(safe_base):
            continue
        for root, _, filenames in os.walk(safe_base):
            for name in filenames:
                ext = os.path.splitext(name)[1].lower()
                if ext not in img_exts:
                    continue
                _add_file(os.path.join(root, name))
    return files


def _collect_material_image_paths():
    """收集素材库/预设正在引用的 static/images 图片，避免混进生成图库。"""
    refs = set()

    def _add_static_image(value):
        if not value or not isinstance(value, str):
            return
        text = value.strip()
        if text.startswith('/static/images/'):
            refs.add(os.path.realpath(os.path.join(BASE_DIR, text.lstrip('/'))))
        elif text.startswith('static/images/'):
            refs.add(os.path.realpath(os.path.join(BASE_DIR, text)))
        else:
            real = os.path.realpath(os.path.expanduser(text))
            if real.startswith(os.path.realpath(IMAGES_DIR) + os.sep):
                refs.add(real)

    def _walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key in ('image', 'thumbnail', 'thumb') and isinstance(value, str):
                    _add_static_image(value)
                elif isinstance(value, (dict, list)):
                    _walk(value)
        elif isinstance(node, list):
            for item in node:
                if isinstance(item, (dict, list)):
                    _walk(item)

    for filename in ('image_library.json', 'image_presets.json'):
        _walk(load_json(filename) or {})
    return refs


def _safe_path(requested_path):
    """校验路径在用户主目录下，防止路径遍历"""
    home = os.path.realpath(os.path.expanduser('~'))
    real = os.path.realpath(requested_path)
    if real == home or real.startswith(home + os.sep):
        return real
    return None


@app.route('/api/gallery', methods=['GET'])
def gallery_list():
    """仅返回软件生成(API返图)并已落盘的图片，按日期分组。"""
    try:
        recent_days = max(0, min(int(request.args.get('recent_days', 0) or 0), 3650))
        cutoff_ts = time.time() - recent_days * 24 * 60 * 60 if recent_days > 0 else 0
        files = _collect_gallery_files()
        groups_map = {}
        total_count = 0
        total_size_kb = 0
        base_paths = sorted({os.path.dirname(p) for p in files})
        for fp in files:
            try:
                st = os.stat(fp)
            except (OSError, PermissionError):
                continue
            if cutoff_ts and st.st_mtime < cutoff_ts:
                continue
            parent = os.path.basename(os.path.dirname(fp))
            label = parent if re.match(r'^\d{4}-\d{2}-\d{2}$', parent) else datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d')
            groups_map.setdefault(label, []).append({
                "name": os.path.basename(fp),
                "path": fp,
                "size_kb": round(st.st_size / 1024, 1),
                "mtime": st.st_mtime
            })
            total_size_kb += st.st_size / 1024
            total_count += 1

        groups = []
        for label, images in groups_map.items():
            images.sort(key=lambda x: x.get('mtime', 0), reverse=True)
            groups.append({"label": label, "images": images})
        groups.sort(key=lambda g: g.get("label", ""), reverse=True)

        base_path = base_paths[0] if base_paths else _get_download_base()
        return jsonify({
            "groups": groups,
            "total_count": total_count,
            "total_size_kb": round(total_size_kb, 1),
            "base_path": base_path,
            "base_paths": base_paths,
            "recent_days": recent_days
        })
    except Exception as e:
        logger.error(f'[gallery] 异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/gallery-image', methods=['GET'])
def gallery_image():
    """代理提供下载目录中的图片（供前端预览，不复制文件）"""
    try:
        img_path = request.args.get('path', '').strip()
        if not img_path:
            return jsonify({"error": "缺少路径参数"}), 400
        safe = _safe_path(img_path)
        if not safe:
            return jsonify({"error": "路径不合法"}), 403
        if not os.path.isfile(safe):
            return jsonify({"error": "文件不存在"}), 404

        ext = os.path.splitext(safe)[1].lower()
        mime_map = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                    '.webp': 'image/webp', '.bmp': 'image/bmp'}
        mimetype = mime_map.get(ext, 'application/octet-stream')

        return send_file(safe, mimetype=mimetype, conditional=True)
    except Exception as e:
        logger.error(f'[gallery-image] 异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/gallery-import-image', methods=['POST'])
def gallery_import_image():
    """将图库中的图片复制到应用 static/images，返回可用于后续处理的本地URL"""
    try:
        body = request.get_json(silent=True) or {}
        src_path = (body.get('path') or '').strip()
        if not src_path:
            return jsonify({"error": "缺少图片路径"}), 400

        safe_src = _safe_path(src_path)
        if not safe_src:
            return jsonify({"error": "路径不合法"}), 403
        if not os.path.isfile(safe_src):
            return jsonify({"error": "文件不存在"}), 404

        ext = os.path.splitext(safe_src)[1].lower()
        if ext not in ('.jpg', '.jpeg', '.png', '.webp', '.bmp'):
            return jsonify({"error": "不支持的图片格式"}), 400

        # 统一复制到应用图片目录，便于拆图与后续处理接口复用
        new_name = f"{gen_id('img')}{ext if ext != '.bmp' else '.jpg'}"
        dst_path = os.path.join(IMAGES_DIR, new_name)

        try:
            if ext == '.bmp':
                with open(safe_src, 'rb') as f:
                    img_bytes = f.read()
                jpg_data, _ = convert_to_jpg(img_bytes)
                with open(dst_path, 'wb') as f:
                    f.write(jpg_data)
            else:
                shutil.copy2(safe_src, dst_path)
        except Exception as e:
            return jsonify({"error": f"复制图片失败: {e}"}), 500

        return jsonify({
            "ok": True,
            "url": f"/static/images/{new_name}",
            "name": os.path.basename(safe_src)
        })
    except Exception as e:
        logger.error(f'[gallery-import-image] 异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/gallery-delete', methods=['POST'])
def gallery_delete():
    """批量删除图库中的图片"""
    try:
        body = request.get_json(silent=True) or {}
        files = body.get('files', [])
        if not files:
            return jsonify({"error": "未指定文件"}), 400

        home = os.path.realpath(os.path.expanduser('~'))
        gallery_file_set = set(_collect_gallery_files())
        deleted = 0
        freed_kb = 0
        errors = []

        safe_files = []
        safe_file_set = set()
        file_size_kb_map = {}

        for f in files:
            real = os.path.realpath(f)
            if not (real == home or real.startswith(home + os.sep)):
                errors.append(f"路径不合法: {f}")
                continue
            if not os.path.isfile(real):
                errors.append(f"文件不存在: {f}")
                continue
            if real not in gallery_file_set:
                errors.append(f"不在图库可删除范围: {f}")
                continue
            if real in safe_file_set:
                continue
            safe_file_set.add(real)
            safe_files.append(real)
            try:
                file_size_kb_map[real] = os.path.getsize(real) / 1024
            except OSError:
                file_size_kb_map[real] = 0

        if safe_files:
            try:
                _move_paths_to_trash(safe_files)
                deleted = len(safe_files)
                freed_kb = sum(file_size_kb_map.get(p, 0) for p in safe_files)
            except Exception as e:
                errors.append(f"移到回收站失败: {e}")

        # 清理空目录
        base = _get_download_base()
        if os.path.isdir(base):
            for entry in os.listdir(base):
                sub = os.path.join(base, entry)
                if os.path.isdir(sub):
                    try:
                        if not os.listdir(sub):
                            os.rmdir(sub)
                    except OSError:
                        pass

        return jsonify({
            "deleted": deleted,
            "trashed": deleted,
            "freed_kb": round(freed_kb, 1),
            "errors": errors[:5]
        })
    except Exception as e:
        logger.error(f'[gallery-delete] 异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/gallery-folder-delete', methods=['POST'])
def gallery_folder_delete():
    """删除整个日期文件夹"""
    try:
        body = request.get_json(silent=True) or {}
        folder_name = body.get('folder', '').strip()
        if not folder_name:
            return jsonify({"error": "未指定文件夹"}), 400

        base = _get_download_base()
        folder_path = os.path.realpath(os.path.join(base, folder_name))

        home = os.path.realpath(os.path.expanduser('~'))
        if not (folder_path.startswith(home + os.sep)):
            return jsonify({"error": "路径不合法"}), 403
        if not folder_path.startswith(os.path.realpath(base)):
            return jsonify({"error": "路径不在下载目录下"}), 403
        if not os.path.isdir(folder_path):
            return jsonify({"error": "文件夹不存在"}), 404

        deleted = 0
        for _, _, files in os.walk(folder_path):
            deleted += len(files)
        freed_kb = _path_size_kb(folder_path)
        _move_path_to_trash(folder_path)

        return jsonify({"deleted": deleted, "trashed": deleted, "freed_kb": round(freed_kb, 1)})
    except Exception as e:
        logger.error(f'[gallery-folder-delete] 异常: {e}', exc_info=True)
        return jsonify({"error": "服务内部错误"}), 500


@app.route('/api/next-image-counter', methods=['POST'])
def next_image_counter():
    """原子递增并返回下一个图片序列号"""
    body = request.get_json(silent=True) or {}
    count = max(1, min(int(body.get('count', 1)), 100))

    with data_lock:
        config = load_json('model_config.json') or {}
        try:
            current = int(config.get('image_counter', 1))
        except (ValueError, TypeError):
            current = 1
        start = current
        config['image_counter'] = current + count
        save_json('model_config.json', config)

    return jsonify({"start": start, "count": count})


def find_free_port(start_port=5800, max_tries=20):
    """从 start_port 开始寻找可用端口，避免与 Clash 等代理软件冲突"""
    for port in range(start_port, start_port + max_tries):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(('0.0.0.0', port))
                # 绑定成功说明端口可用
                return port
        except OSError:
            logger.warning(f"端口 {port} 已被占用，尝试下一个端口...")
            continue
    logger.error(f"在 {start_port}-{start_port + max_tries - 1} 范围内未找到可用端口")
    return None


def check_existing_instance(start_port=5800, max_tries=20):
    """检测指定端口范围是否已有本程序实例在运行。
    如果有，返回端口号；如果没有，返回 None。"""
    for port in range(start_port, start_port + max_tries):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(3)
                s.connect(('127.0.0.1', port))
                s.sendall(b'GET /api/model-config HTTP/1.0\r\nHost: localhost\r\n\r\n')
                data = b''
                while True:
                    try:
                        chunk = s.recv(8192)
                        if not chunk:
                            break
                        data += chunk
                    except socket.timeout:
                        break
                resp = data.decode('utf-8', errors='ignore')
                if 'rh_api_key' in resp or 'api_platform' in resp or 'upload_short_edge' in resp:
                    return port
        except (OSError, ConnectionRefusedError, socket.timeout):
            pass
    return None


# ========== 启动 ==========

if __name__ == '__main__':
    # 先检测是否已有本程序实例在运行（扫描 5800-5819 全范围）
    existing_port = check_existing_instance(5800)
    if existing_port:
        print(f'\n✅ 检测到程序已在运行（端口 {existing_port}），直接打开浏览器...')
        import webbrowser
        webbrowser.open(f'http://localhost:{existing_port}')
        import sys
        sys.exit(0)

    ensure_data_dir()
    # 清理之前的临时导出目录
    import glob as _glob
    _temp_root = tempfile.gettempdir()
    for _d in _glob.glob(os.path.join(_temp_root, 'ai_export_images_*')):
        try:
            shutil.rmtree(_d, ignore_errors=True)
        except Exception:
            pass

    # 热重载时，子进程通过环境变量继承父进程确定的端口，避免重新检测导致端口漂移
    _inherited_port = os.environ.get('AI_SERVER_PORT', '')
    if _inherited_port.isdigit():
        port = int(_inherited_port)
    else:
        # 自动检测可用端口（避免与 Clash/小龙虾等代理软件冲突）
        port = find_free_port(5800)
        if port is None:
            print("\n❌ 错误：找不到可用端口（5800-5819 均被占用）")
            print("   请检查是否有其他程序（如 Clash/小龙虾代理）占用了这些端口")
            print("   或手动修改 app.py 中的端口号")
            import sys
            sys.exit(1)

    # 将端口写入环境变量，热重载子进程会继承此值
    os.environ['AI_SERVER_PORT'] = str(port)

    # 生产使用默认关闭热重载：代码文件变化不能中断已经付费提交、正在等待
    # 平台返回的任务。仅开发调试时显式设置 AI_HOT_RELOAD=1。
    hot_reload = os.environ.get('AI_HOT_RELOAD', '0').strip().lower() in ('1', 'true', 'yes', 'on')

    # 将端口写入临时文件，供启动脚本读取实际运行端口
    _port_file = '/tmp/ai_prompt_generator_port'
    try:
        with open(_port_file, 'w') as f:
            f.write(str(port))
    except Exception:
        pass

    logger.info("=" * 50)
    logger.info("样片工厂 启动中...")
    logger.info(f"数据目录: {DATA_DIR}")
    logger.info(f"图片目录: {IMAGES_DIR}")
    logger.info(f"访问地址: http://localhost:{port}")
    logger.info(f"热重载: {'开启' if hot_reload else '关闭'} (AI_HOT_RELOAD)")
    logger.info("=" * 50)

    if port != 5800:
        print(f"\n⚠️  端口 5800 已被占用（可能是 Clash/小龙虾代理），已自动切换到端口 {port}")
        print(f"   请访问: http://localhost:{port}\n")

    # 是否自动打开浏览器（默认关闭，避免热重载/端口切换时频繁弹窗）
    auto_open_browser = os.environ.get('AI_AUTO_OPEN_BROWSER', '0').strip().lower() in ('1', 'true', 'yes', 'on')
    # 开启热重载时仅在reloader子进程打开，避免重复弹窗
    should_open_browser = auto_open_browser and ((not hot_reload) or (os.environ.get('WERKZEUG_RUN_MAIN') == 'true'))
    if should_open_browser:
        import webbrowser
        import threading
        def _open_browser():
            webbrowser.open(f'http://localhost:{port}')
        threading.Timer(1.5, _open_browser).start()

    # Werkzeug 热重载父进程不执行任务；实际服务子进程恢复未完成的运行批次。
    if (not hot_reload) or (os.environ.get('WERKZEUG_RUN_MAIN') == 'true'):
        _ecommerce_resume_running_batches()
        # 启动时清理超过 30 天的临时目录文件（_重做临时参考图、_重做历史、_质检缓存等）
        try:
            _ecommerce_cleanup_temp_dirs(max_age_days=30)
        except Exception as exc:
            logger.warning(f'[startup] 临时目录清理失败: {exc}')

    app.run(
        host='0.0.0.0',
        port=port,
        debug=False,
        use_reloader=hot_reload,
        threaded=True
    )
