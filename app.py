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
from datetime import datetime, timedelta
from logging.handlers import RotatingFileHandler
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from PIL import Image, ImageOps
from flask import Flask, jsonify, request, render_template, send_from_directory, send_file

# 防止解压炸弹：限制PIL最大像素数（1亿像素≈10K×10K）
Image.MAX_IMAGE_PIXELS = 100_000_000

app = Flask(__name__)

# 上传大小限制 10MB
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB，支持超大原图上传（前端裁剪后仍可能较大）

# 全局数据锁，防止并发读写竞态
data_lock = threading.RLock()

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
logger.addHandler(file_handler)
# 同时给root logger加文件handler，确保所有模块的日志都写入文件
logging.getLogger().addHandler(file_handler)

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
IMAGES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static', 'images')
BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backups')
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# ========== 安全辅助函数 ==========

# 允许代理下载的图片域名白名单
ALLOWED_IMAGE_DOMAINS = {
    'runninghub.cn', 'www.runninghub.cn',
    'openai-hk.com', 'api.openai-hk.com',
    'fal.media', 'v3.fal.media', 'storage.fal.media',
    'replicate.com', 'api.replicate.com',
    'pbxt.replicate.delivery',
}

# 允许代理 API 的 base_url 域名白名单
ALLOWED_API_DOMAINS = {
    'runninghub.cn', 'www.runninghub.cn',
    'openai-hk.com', 'api.openai-hk.com',
    'deepseek.com', 'api.deepseek.com',
    'bigmodel.cn', 'open.bigmodel.cn',
}

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
                        return False, f"不允许访问内网地址: {addr}", None
                    # 使用第一个有效的公网IP
                    if resolved_ip is None:
                        resolved_ip = addr
                except ValueError:
                    continue
        except socket.gaierror:
            pass  # 域名无法解析，让requests处理
        # 检查域名白名单
        host_lower = hostname.lower()
        for domain in allowed_domains:
            if host_lower == domain or host_lower.endswith('.' + domain):
                return True, None, resolved_ip
        return False, f"域名不在白名单中: {hostname}", None
    except Exception as e:
        return False, f"URL解析失败: {e}", None


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
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


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
    return render_template('index.html')


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
    body = request.get_json()
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
        data = {"presets": []}
    if 'presets' not in data:
        data['presets'] = []
    return jsonify(data)


@app.route('/api/prompt-presets', methods=['PUT'])
def update_prompt_presets():
    """保存提示词预设列表"""
    body = request.get_json()
    with data_lock:
        save_json('prompt_presets.json', {"presets": body.get('presets', [])})
    logger.info(f"更新提示词预设: {len(body.get('presets', []))}个")
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

MAX_IMAGE_SIZE = 2048  # 短边最大像素


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


def compress_image(file_stream, ext):
    """统一缩放+压缩图片（单流架构：前端已裁剪为3:4，服务端只做缩放+压缩）
    返回 (buf, '.jpg', warning) 其中warning为上采样警告字符串或None"""
    short_edge_target, _ = get_upload_settings()
    warning = None

    img = Image.open(file_stream)
    img = ImageOps.exif_transpose(img)

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
        compressed, final_ext, warning = compress_image(file.stream, ext)
        filename = f"{gen_id('img')}{final_ext}"
        filepath = os.path.join(IMAGES_DIR, filename)
        with open(filepath, 'wb') as f:
            f.write(compressed.read())
        file_size = os.path.getsize(filepath)
        short_edge_target, _ = get_upload_settings()
        logger.info(f"[upload] 图片上传成功: {filename}, 大小: {file_size//1024}KB, 短边={short_edge_target}px")
        result = {"url": f"/static/images/{filename}"}
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
def update_model_config():
    body = request.get_json()
    # 只允许已知字段，防止注入任意键
    ALLOWED_FIELDS = {
        'provider', 'api_key', 'base_url', 'model_name', 'timeout_ms', 'retry_count',
        'system_prompt_prompt', 'system_prompt_translate',
        'rh_api_key', 'rh_base_url', 'rh_model', 'rh_aspect_ratio', 'rh_resolution', 'rh_count', 'rh_seed_mode', 'rh_seed',
        'oaihk_api_key', 'oaihk_base_url', 'oaihk_model', 'oaihk_aspect_ratio',
        'api_platform',
    }
    body = {k: v for k, v in body.items() if k in ALLOWED_FIELDS}
    # 自动去除关键字段的空格
    for key in ['api_key', 'base_url', 'model_name']:
        if key in body and isinstance(body[key], str):
            body[key] = body[key].strip()
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
    timeout_ms = config.get('timeout_ms', 30000)

    if not api_key:
        return jsonify({"success": False, "message": "API Key 不能为空"}), 400

    try:
        if provider == 'deepseek':
            url = (base_url.rstrip('/') if base_url else 'https://api.deepseek.com') + '/chat/completions'
            model = model_name or 'deepseek-chat'
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

@app.route('/api/queue-data', methods=['GET'])
def get_queue_data():
    data = load_json('queue_data.json')
    if data is None:
        return jsonify({"queues": [], "activeQueue": 0, "queueMode": "same", "slots": []})
    return jsonify(data)


@app.route('/api/queue-data', methods=['PUT'])
def save_queue_data():
    body = request.get_json()
    with data_lock:
        save_json('queue_data.json', body)
    return jsonify({"success": True})


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
    timeout_ms = config.get('timeout_ms', 30000)
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
        model = model_name or 'deepseek-chat'
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
    'model_config.json', 'usage_log.json', 'prefix_templates.json',
    'prompt_templates.json', 'prompt_presets.json'
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


@app.route('/api/cleanup-images', methods=['POST'])
def cleanup_images():
    """清理未被任何 JSON 数据引用的孤立图片"""
    with data_lock:
        # 1. 收集所有被引用的图片文件名
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

        # 2. 扫描 images 目录，找出未引用的文件
        orphaned = []
        if os.path.exists(IMAGES_DIR):
            for img_file in os.listdir(IMAGES_DIR):
                if img_file.startswith('.'):
                    continue
                if img_file not in referenced_images:
                    orphaned.append(img_file)

        # 3. 删除未引用文件
        deleted_count = 0
        freed_bytes = 0
        for img_file in orphaned:
            img_path = os.path.join(IMAGES_DIR, img_file)
            try:
                freed_bytes += os.path.getsize(img_path)
                os.remove(img_path)
                deleted_count += 1
            except Exception as e:
                logger.warning(f"清理图片失败: {img_file}, {e}")

    logger.info(f"清理未引用图片: 删除{deleted_count}张, 释放{freed_bytes//1024}KB")
    return jsonify({
        "success": True,
        "deleted": deleted_count,
        "freed_kb": freed_bytes // 1024
    })


@app.route('/api/import', methods=['POST'])
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
        return jsonify({"error": f"导入失败: {str(e)}"}), 500


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
    timeout_ms = model_config.get('timeout_ms', 30000)
    retry_count = model_config.get('retry_count', 2)

    if not api_key:
        return jsonify({"error": "API Key 未配置，请先在模型配置中设置"}), 400

    # 使用自定义系统提示词（如果有），否则用默认
    custom_bilingual_prompt = model_config.get('system_prompt_bilingual', '').strip()
    system_prompt_to_use = custom_bilingual_prompt if custom_bilingual_prompt else BILINGUAL_SYSTEM_PROMPT

    if provider == 'deepseek':
        url = (base_url.rstrip('/') if base_url else 'https://api.deepseek.com') + '/chat/completions'
        model = model_name or 'deepseek-chat'
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
    timeout_ms = model_config.get('timeout_ms', 30000)
    retry_count = model_config.get('retry_count', 2)

    if not api_key:
        return jsonify({"error": "API Key 未配置"}), 400

    if provider == 'deepseek':
        url = (base_url.rstrip('/') if base_url else 'https://api.deepseek.com') + '/chat/completions'
        model = model_name or 'deepseek-chat'
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

@app.route('/api/rh-proxy', methods=['POST'])
def rh_proxy():
    """代理 RunningHub API 请求，避免前端 CORS 问题
    API Key 从服务端配置读取，前端无需传递真实密钥"""
    body = request.get_json()
    action = body.get('action')  # 'submit' or 'query'

    # 从服务端配置读取真实密钥（前端可能传遮蔽值，不可信）
    config = load_json('model_config.json') or {}
    rh_api_key = config.get('rh_api_key', '').strip()
    rh_base_url = config.get('rh_base_url', 'https://www.runninghub.cn/openapi/v2').rstrip('/')
    # 允许前端覆盖 base_url（但不覆盖 api_key），需验证域名
    if body.get('base_url', '').strip():
        custom_base = body['base_url'].strip().rstrip('/')
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
            params = body.get('params', {})
            url = f"{rh_base_url}/{model_id}"

            headers = {
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {rh_api_key}'
            }
            resp = requests.post(url, headers=headers, json=params, timeout=30)
            result = resp.json()
            return jsonify(result), resp.status_code

        elif action == 'query':
            # 查询任务状态
            task_id = body.get('task_id', '')
            url = f"{rh_base_url}/query"

            headers = {
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {rh_api_key}'
            }
            resp = requests.post(url, headers=headers, json={"taskId": task_id}, timeout=30)
            result = resp.json()
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
        return jsonify({"error": "请求超时"}), 504
    except Exception as e:
        logger.error(f"RH代理请求失败: {e}")
        return jsonify({"error": str(e)}), 500


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
        return jsonify({"error": str(e)}), 500


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

    logger.info(f'[oaihk] 代理请求: action={action}, base_url={base_url}')

    try:
        if action == 'submit':
            endpoint = body.get('endpoint', '')
            model_id = body.get('model_id', '')
            params = body.get('params', {})
            url = f"{base_url}/{endpoint}"
            headers = {
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {api_key}'
            }
            # 确保params中包含model字段（部分API需要）
            if model_id and 'model' not in params:
                params['model'] = model_id
            logger.info(f'[oaihk] 提交任务: url={url}, model={model_id}, prompt={params.get("prompt","")[:80]}..., image_urls={len(params.get("image_urls",[]))}张')
            resp = requests.post(url, headers=headers, json=params, timeout=120)
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
                    result['error'] = err['message']
            return jsonify(result), resp.status_code

        elif action == 'poll':
            poll_endpoint = body.get('poll_endpoint', '')
            request_id = body.get('request_id', '')
            if not request_id:
                logger.error('[oaihk] 轮询缺少request_id')
                return jsonify({"error": "轮询缺少request_id，请先成功提交任务"}), 400
            url = f"{base_url}/{poll_endpoint}/{request_id}"
            headers = {
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json'
            }
            resp = requests.get(url, headers=headers, timeout=30)
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
                    result['error'] = err['message']
            return jsonify(result), resp.status_code

        else:
            return jsonify({"error": "未知操作"}), 400

    except requests.exceptions.Timeout:
        logger.error(f'[oaihk] 请求超时: action={action}')
        return jsonify({"error": "请求超时"}), 504
    except Exception as e:
        logger.error(f'[oaihk] 代理请求异常: {e}', exc_info=True)
        return jsonify({"error": str(e)}), 500


@app.route('/api/preprocess-and-upload', methods=['POST'])
def preprocess_and_upload():
    """读取本地图片 → 按比例裁剪+缩放 → JPG Q90 → 上传tmpfiles图床 → 返回直链URL"""
    body = request.get_json(silent=True) or {}
    local_url = body.get('local_url', '')
    aspect_ratio = body.get('aspect_ratio', '3:4')  # e.g. "3:4"
    short_edge = int(body.get('short_edge', 1536))

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
        return jsonify({"error": str(e)}), 500


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
        return jsonify({"error": str(e)}), 500


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
        return jsonify({"error": str(e)}), 500


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

        # 自动转为JPG格式（保持像素和尺寸不变，方便Mac Finder预览大图）
        jpg_data, jpg_ext = convert_to_jpg(data)
        if jpg_ext:
            data = jpg_data
            content_type = 'image/jpeg'

        b64_str = base64.b64encode(data).decode('ascii')
        data_uri = f'data:{content_type};base64,{b64_str}'
        logger.info(f'[download-proxy] 下载完成: {len(data)//1024}KB, type={content_type}')

        return jsonify({"data": {"data_uri": data_uri, "size_kb": len(data) // 1024, "content_type": content_type}}), 200

    except requests.exceptions.Timeout:
        logger.error('[download-proxy] 下载超时')
        return jsonify({"error": "下载超时"}), 504
    except Exception as e:
        logger.error(f'[download-proxy] 下载异常: {e}', exc_info=True)
        return jsonify({"error": str(e)}), 500

@app.route('/api/save-image-to-path', methods=['POST'])
def save_image_to_path():
    """将图片下载保存到用户指定的本地路径，自动创建日期子文件夹"""
    body = request.get_json(silent=True) or {}
    image_url = body.get('url', '')
    base_path = body.get('path', '')
    filename = body.get('filename', '')

    if not image_url:
        return jsonify({"error": "缺少图片URL"}), 400
    if not base_path:
        return jsonify({"error": "缺少保存路径"}), 400

    # SSRF防护：验证URL域名
    ok, err, _ = _validate_url(image_url, ALLOWED_IMAGE_DOMAINS)
    if not ok:
        logger.warning(f'[save-image] SSRF拦截: {err}')
        return jsonify({"error": f"URL不允许: {err}"}), 403

    # 路径安全：验证base_path在允许范围内
    ok, err = _validate_base_path(base_path)
    if not ok:
        logger.warning(f'[save-image] 路径拦截: {err}')
        return jsonify({"error": f"路径不允许: {err}"}), 403

    # 展开 ~ 为用户主目录
    base_path = os.path.expanduser(base_path)

    # 创建以当前日期命名的子文件夹
    date_folder = datetime.now().strftime('%Y-%m-%d')
    target_dir = os.path.join(base_path, date_folder)

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
        resp = requests.get(image_url, timeout=120, stream=True)
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
    except Exception as e:
        logger.error(f'[save-image] 保存异常: {e}', exc_info=True)
        return jsonify({"error": str(e)}), 500


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

    # 读取用户配置的备份路径
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
        if image_url.startswith('/'):
            local_path = _resolve_local_path(image_url)
            base_dir = _resolve_base_for_path_check(image_url)
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

        # 转JPG
        jpg_data, jpg_ext = convert_to_jpg(data)
        if jpg_data:
            data = jpg_data
            name_part2, ext_part2 = os.path.splitext(os.path.basename(filepath))
            if ext_part2.lower() not in ('.jpg', '.jpeg'):
                filepath = os.path.splitext(filepath)[0] + '.jpg'

        with open(filepath, 'wb') as f:
            f.write(data)

        # 同时复制到 static/images/backup/ 供Web访问
        backup_web_dir = os.path.join(IMAGES_DIR, 'backup')
        os.makedirs(backup_web_dir, exist_ok=True)
        web_filename = os.path.basename(filepath)
        web_filepath = os.path.join(backup_web_dir, web_filename)
        # 避免冲突
        if os.path.exists(web_filepath) and os.path.getsize(web_filepath) != len(data):
            name_w, ext_w = os.path.splitext(web_filename)
            counter = 1
            while os.path.exists(os.path.join(backup_web_dir, f"{name_w}_{counter}{ext_w}")):
                counter += 1
            web_filename = f"{name_w}_{counter}{ext_w}"
            web_filepath = os.path.join(backup_web_dir, web_filename)
        if not os.path.exists(web_filepath):
            with open(web_filepath, 'wb') as f:
                f.write(data)

        local_url = f'/static/images/backup/{web_filename}'
        logger.info(f'[backup] 图片备份成功: {filepath} -> {local_url} ({len(data)//1024}KB)')
        return jsonify({
            "ok": True,
            "path": filepath,
            "local_url": local_url,
            "size_kb": len(data) // 1024
        }), 200

    except requests.exceptions.Timeout:
        return jsonify({"error": "下载超时"}), 504
    except Exception as e:
        logger.error(f'[backup] 备份异常: {e}', exc_info=True)
        return jsonify({"error": str(e)}), 500


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
def get_logs():
    """返回最近N行日志，供调试查看（仅限本地访问）"""
    # 限制仅本地访问，防止信息泄露
    if request.remote_addr not in ('127.0.0.1', '::1'):
        return jsonify({"error": "禁止访问"}), 403
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
        return jsonify({"error": str(e)}), 500


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
            p = p.replace('\\', '\\\\').replace('"', '\\"')
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
        return jsonify({'success': False, 'error': str(e)})


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
        return jsonify({'success': False, 'error': str(e)})


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

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def _get_local_version():
    """读取本地版本号"""
    vpath = os.path.join(BASE_DIR, 'version.json')
    if os.path.exists(vpath):
        try:
            with open(vpath, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {"version": "0.0.0", "name": "人像 Prompt 生成器 PRO", "repo": "lengjueqi-coder/TTyangpian"}


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
        return jsonify({"has_update": False, "error": str(e)})


# 更新状态（内存中）
_update_state = {"running": False, "progress": "", "error": None}
_update_state_lock = threading.Lock()


@app.route('/api/do-update', methods=['POST'])
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
            # 1. 下载 zip
            _set_update_state(progress="正在下载更新包...")
            logger.info(f"[更新] 开始下载: {download_url}")
            resp = requests.get(download_url, timeout=120, stream=True)
            resp.raise_for_status()
            zip_path = os.path.join(tempfile.gettempdir(), 'TTyangpian_update.zip')
            with open(zip_path, 'wb') as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)
            logger.info(f"[更新] 下载完成: {zip_path}")

            # 2. 解压到临时目录
            _update_state["progress"] = "正在解压..."
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
            _update_state["progress"] = "正在替换文件..."
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
            _update_state["progress"] = "更新完成，正在重启..."
            logger.info("[更新] 准备重启服务")

            # 用新进程替换当前进程
            import sys
            os.execv(sys.executable, [sys.executable] + sys.argv)

        except Exception as e:
            _update_state["error"] = str(e)
            _update_state["running"] = False
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
        return jsonify({"error": str(e)}), 500



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


# ========== 启动 ==========

if __name__ == '__main__':
    ensure_data_dir()
    # 清理之前的临时导出目录
    import glob as _glob
    _temp_root = tempfile.gettempdir()
    for _d in _glob.glob(os.path.join(_temp_root, 'ai_export_images_*')):
        try:
            shutil.rmtree(_d, ignore_errors=True)
        except Exception:
            pass

    # 自动检测可用端口（避免与 Clash/小龙虾等代理软件冲突）
    port = find_free_port(5800)
    if port is None:
        print("\n❌ 错误：找不到可用端口（5800-5819 均被占用）")
        print("   请检查是否有其他程序（如 Clash/小龙虾代理）占用了这些端口")
        print("   或手动修改 app.py 中的端口号")
        import sys
        sys.exit(1)

    logger.info("=" * 50)
    logger.info("人像 Prompt 生成器 PRO 启动中...")
    logger.info(f"数据目录: {DATA_DIR}")
    logger.info(f"图片目录: {IMAGES_DIR}")
    logger.info(f"访问地址: http://localhost:{port}")
    logger.info("=" * 50)

    if port != 5800:
        print(f"\n⚠️  端口 5800 已被占用（可能是 Clash/小龙虾代理），已自动切换到端口 {port}")
        print(f"   请访问: http://localhost:{port}\n")

    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
