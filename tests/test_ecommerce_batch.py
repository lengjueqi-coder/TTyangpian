import base64
import errno
import io
import json
import os
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor, as_completed
from unittest.mock import Mock, patch

from PIL import Image

import app as app_module


class EcommerceBatchTest(unittest.TestCase):
    def setUp(self):
        self.data_temp = tempfile.TemporaryDirectory()
        self.user_temp = tempfile.TemporaryDirectory(dir=os.environ.get("ECOMMERCE_TEST_TMP") or "/private/tmp")
        self.old_data_dir = app_module.DATA_DIR
        self.old_images_dir = app_module.IMAGES_DIR
        app_module.DATA_DIR = os.path.join(self.data_temp.name, "data")
        app_module.IMAGES_DIR = os.path.join(self.data_temp.name, "images")
        os.makedirs(app_module.DATA_DIR, exist_ok=True)
        os.makedirs(app_module.IMAGES_DIR, exist_ok=True)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.DATA_DIR = self.old_data_dir
        app_module.IMAGES_DIR = self.old_images_dir
        self.user_temp.cleanup()
        self.data_temp.cleanup()

    @staticmethod
    def make_image(path, color=(80, 120, 160)):
        Image.new("RGB", (32, 48), color).save(path, "JPEG")

    def make_garment(self, name, count=6):
        folder = os.path.join(self.user_temp.name, name)
        os.makedirs(folder)
        for number in range(1, count + 1):
            self.make_image(os.path.join(folder, f"{number}-参考.jpg"))
        return folder

    def test_rerun_ui_exposes_draw_count_and_single_prompt_has_priority(self):
        script_path = os.path.join(os.path.dirname(app_module.__file__), 'static', 'js', 'app.js')
        template_path = os.path.join(os.path.dirname(app_module.__file__), 'templates', 'index.html')
        with open(script_path, encoding='utf-8') as handle:
            script = handle.read()
        with open(template_path, encoding='utf-8') as handle:
            template = handle.read()
        self.assertIn('id="ecommerce-rerun-draw-count"', script)
        self.assertIn('Math.max(drawCount, Math.min(parseInt(item.missing_count, 10) || 1, 5))', script)
        self.assertIn("String(item.rerun_prompt || '').trim() || prompt", script)
        self.assertIn('预计付费生图 ${paidCallTotal} 张', script)
        self.assertIn('参考图支持1～9张', script)
        self.assertIn('class="ecommerce-rerun-sync-select"', script)
        self.assertIn('function ecommerceRerunAdjustmentTargets(item)', script)
        self.assertIn('advanceEcommerceRerunWorkflow(index, syncEnabled)', script)
        self.assertIn('保存当前并下一张', script)
        self.assertIn('id="ecommerce-rerun-adjust-panel"', template)
        self.assertIn('id="ecommerce-rerun-adjust-host"', template)
        self.assertIn("const host = document.getElementById('ecommerce-rerun-adjust-host')", script)
        self.assertIn('`第 ${currentGroupIdx + 1}/${allGarmentIds.length} 套 · ${item.garment_name}`', script)
        self.assertIn('`本套第 ${currentItemInGarment + 1}/${sameGarmentItems.length} 张', script)
        self.assertNotIn('list.appendChild(compare)', script)

    def test_scan_requires_all_six_numbered_images(self):
        self.make_garment("完整款")
        self.make_garment("缺图款", count=5)
        response = self.client.post(
            "/api/ecommerce/scan-clothing-root",
            json={"path": self.user_temp.name},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["garment_count"], 1)
        self.assertEqual(payload["garments"][0]["name"], "完整款")
        self.assertEqual(len(payload["garments"][0]["images"]), 6)
        self.assertEqual(payload["invalid"][0]["name"], "缺图款")

    def test_exactly_six_camera_named_images_use_natural_order(self):
        folder = os.path.join(self.user_temp.name, "相机编号款")
        os.makedirs(folder)
        names = ["7.16旗袍拍摄22021.jpg", "7.16旗袍拍摄22022.jpg", "7.16旗袍拍摄22023.jpg", "7.16旗袍拍摄22024.jpg", "7.16旗袍拍摄22025.jpg", "7.16旗袍拍摄22026.jpg"]
        for name in names:
            self.make_image(os.path.join(folder, name))
        response = self.client.post("/api/ecommerce/scan-clothing-root", json={"path": self.user_temp.name})
        garment = next(g for g in response.get_json()["garments"] if g["name"] == "相机编号款")
        self.assertEqual([os.path.basename(path) for path in garment["images"]], names)

    def test_model_named_ai_outputs_are_never_rescanned_as_garment_references(self):
        folder = os.path.join(self.user_temp.name, "同目录模型测试款")
        os.makedirs(folder)
        reference_names = [f"旗袍拍摄22{i:03d}.jpg" for i in range(1, 7)]
        for name in reference_names:
            self.make_image(os.path.join(folder, name))
        self.make_image(os.path.join(folder, "RH-NB2-LC-4K-R02-AI-01.jpg"))
        self.make_image(os.path.join(folder, "HK-GPT2-OFF-4K-R01-AI-01.jpg"))
        response = self.client.post("/api/ecommerce/scan-clothing-root", json={"path": folder})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(
            [os.path.basename(path) for path in response.get_json()["garments"][0]["images"]],
            reference_names,
        )

    def test_direct_single_folder_accepts_one_to_six_images(self):
        folder = self.make_garment("三图单套", count=3)
        response = self.client.post("/api/ecommerce/scan-clothing-root", json={"path": folder})
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["garment_count"], 1)
        self.assertEqual(len(payload["garments"][0]["images"]), 3)

    def test_create_batch_accepts_inline_single_garment_images(self):
        folder = self.make_garment("拖入单套", count=2)
        action_image = os.path.join(folder, "1-参考.jpg")
        garment_images = [os.path.join(folder, f"{i}-参考.jpg") for i in (1, 2)]
        response = self.client.post('/api/ecommerce/batches', json={
            'actions': [{'action_image': action_image, 'prompt': '测试提示词', 'platform': 'runninghub'}],
            'garment_images': garment_images,
            'garment_name': '拖入单套',
            'output_path': self.user_temp.name,
            'final_output_path': self.user_temp.name,
            'qc_enabled': False,
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        batch = response.get_json()['batch']
        self.assertEqual(len(batch['garments']), 1)
        self.assertEqual(len(batch['garments'][0]['images']), 2)

    def test_prompt_mode_single_selected_image_creates_exactly_one_task(self):
        source = os.path.join(self.user_temp.name, "single-garment.jpg")
        self.make_image(source)
        response = self.client.post('/api/ecommerce/batches', json={
            'generation_mode': 'garment_prompt',
            'actions': [],
            'prompt_action': {
                'prompt': '根据这张服装图和提示词生成图片',
                'platform': 'runninghub',
                'model_key': 'rhart-image-n-g31-flash/image-to-image-2k',
                'endpoint': 'rhart-image-n-g31-flash/image-to-image',
                'resolution': '2k',
            },
            'garment_images': [source],
            'garment_name': '单张服装原图',
            'output_path': self.user_temp.name,
            'final_output_path': os.path.join(self.user_temp.name, 'prompt-output'),
            'qc_enabled': True,
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        payload = response.get_json()
        batch = payload['batch']
        self.assertEqual(batch['generation_mode'], 'garment_prompt')
        self.assertEqual(batch['settings']['generation_mode'], 'garment_prompt')
        self.assertFalse(batch['settings']['qc_enabled'])
        self.assertEqual(batch['task_total'], 1)
        self.assertEqual(batch['garments'][0]['images'], [os.path.realpath(source)])
        self.assertEqual(batch['template']['actions'][0]['action_image'], os.path.realpath(source))
        self.assertEqual(batch['template']['actions'][0]['garment_id'], batch['garments'][0]['id'])
        self.assertIn('1张服装原图', payload['warning'])

    def test_prompt_mode_recursively_scans_all_images_and_preserves_tree(self):
        root = os.path.join(self.user_temp.name, '本次素材')
        nested = os.path.join(root, '批次A', '款01')
        os.makedirs(nested)
        root_image = os.path.join(root, '封面.jpg')
        first = os.path.join(root, '批次A', '2.jpg')
        second = os.path.join(root, '批次A', '10.jpg')
        deep = os.path.join(nested, '细节.png')
        for path in (root_image, first, second, deep):
            self.make_image(path)
        self.make_image(os.path.join(root, '批次A', 'RH-NB2-LC-4K-R02-AI-01.jpg'))

        scan = self.client.post('/api/ecommerce/scan-clothing-root', json={
            'path': root, 'generation_mode': 'garment_prompt',
        })
        self.assertEqual(scan.status_code, 200, scan.get_json())
        scanned = scan.get_json()
        self.assertEqual(scanned['image_total'], 4)
        self.assertEqual([group['name'] for group in scanned['garments']], ['本次素材', '批次A', os.path.join('批次A', '款01')])
        self.assertEqual(
            [os.path.basename(path) for path in scanned['garments'][1]['images']],
            ['2.jpg', '10.jpg'],
        )

        final_root = os.path.join(self.user_temp.name, '成品')
        response = self.client.post('/api/ecommerce/batches', json={
            'generation_mode': 'garment_prompt',
            'prompt_action': {
                'prompt': '所有原图共用的提示词', 'platform': 'runninghub',
                'model_key': 'rhart-image-n-g31-flash/image-to-image-2k',
                'endpoint': 'rhart-image-n-g31-flash/image-to-image', 'resolution': '2k',
            },
            'clothing_root': root,
            'output_path': os.path.join(self.user_temp.name, '缓存'),
            'final_output_path': final_root,
            'qc_enabled': True,
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        batch = response.get_json()['batch']
        self.assertEqual(batch['task_total'], 4)
        self.assertEqual(len(batch['template']['actions']), 4)
        self.assertTrue(all(
            action['garment_id'] == task['garment_id']
            for action in batch['template']['actions']
            for task in batch['tasks']
            if action['id'] == task['action_id']
        ))
        by_name = {group['name']: group for group in batch['garments']}
        self.assertEqual(
            os.path.dirname(batch['result_dirs'][by_name[os.path.join('批次A', '款01')]['id']]),
            os.path.join(final_root, '本次素材', '批次A', '款01'),
        )

    def test_prompt_mode_dragged_directory_sources_keep_original_relative_groups(self):
        source_a = os.path.join(self.user_temp.name, '上传缓存A.jpg')
        source_b = os.path.join(self.user_temp.name, '上传缓存B.jpg')
        source_c = os.path.join(self.user_temp.name, '上传缓存C.jpg')
        for path in (source_a, source_b, source_c):
            self.make_image(path)
        final_root = os.path.join(self.user_temp.name, '拖入目录成品')
        response = self.client.post('/api/ecommerce/batches', json={
            'generation_mode': 'garment_prompt',
            'prompt_action': {
                'prompt': '目录内所有图片共用提示词', 'platform': 'runninghub',
                'model_key': 'rhart-image-n-g31-flash/image-to-image-2k',
                'endpoint': 'rhart-image-n-g31-flash/image-to-image', 'resolution': '2k',
            },
            'garment_sources': [
                {'source': source_a, 'name': '01.jpg', 'relative_path': '旗袍批次/款A/01.jpg'},
                {'source': source_b, 'name': '01.jpg', 'relative_path': '旗袍批次/款B/01.jpg'},
                {'source': source_c, 'name': '02.jpg', 'relative_path': '旗袍批次/款B/细节/02.jpg'},
            ],
            'garment_name': '旗袍批次',
            'output_path': os.path.join(self.user_temp.name, '拖入目录缓存'),
            'final_output_path': final_root,
            'samples_per_action': 1,
            'qc_enabled': False,
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        batch = response.get_json()['batch']
        self.assertEqual(batch['task_total'], 3)
        groups = {garment['name']: garment for garment in batch['garments']}
        self.assertEqual(set(groups), {'旗袍批次/款A', '旗袍批次/款B', '旗袍批次/款B/细节'})
        for group_name, garment in groups.items():
            self.assertEqual(
                os.path.dirname(batch['result_dirs'][garment['id']]),
                os.path.join(final_root, *group_name.split('/')),
            )
        actions = batch['template']['actions']
        self.assertEqual([action['name'] for action in actions], ['01', '01', '02'])
        self.assertEqual(
            [action['source_relative_path'] for action in actions],
            ['旗袍批次/款A/01.jpg', '旗袍批次/款B/01.jpg', '旗袍批次/款B/细节/02.jpg'],
        )
        self.assertTrue(all(
            next(task for task in batch['tasks'] if task['action_id'] == action['id'])['garment_id'] == action['garment_id']
            for action in actions
        ))

    def test_zero_padded_01_to_06_names_are_numbered_references(self):
        folder = os.path.join(self.user_temp.name, "补零编号款")
        os.makedirs(folder)
        for number in range(1, 7):
            self.make_image(os.path.join(folder, f"{number:02d}-旗袍拍摄.jpg"))
        images = app_module._ecommerce_ordered_six_images(folder)
        self.assertEqual([os.path.basename(images[str(i)]) for i in range(1, 7)], [f"{i:02d}-旗袍拍摄.jpg" for i in range(1, 7)])

    def test_keyword_selects_one_camera_sequence_from_extra_images(self):
        folder = os.path.join(self.user_temp.name, "混合拍摄款")
        os.makedirs(folder)
        wanted = [f"旗袍拍摄2202{i}.jpg" for i in range(1, 7)]
        for name in wanted + [f"花絮3300{i}.jpg" for i in range(1, 5)]:
            self.make_image(os.path.join(folder, name))
        response = self.client.post(
            "/api/ecommerce/scan-clothing-root",
            json={"path": folder, "keyword": "旗袍"},
        )
        payload = response.get_json()
        self.assertEqual(payload["garment_count"], 1)
        self.assertEqual([os.path.basename(path) for path in payload["garments"][0]["images"]], wanted)

    def test_keyword_with_more_than_six_matches_is_rejected_as_ambiguous(self):
        folder = os.path.join(self.user_temp.name, "关键词过宽")
        os.makedirs(folder)
        for i in range(1, 8):
            self.make_image(os.path.join(folder, f"旗袍拍摄{i}.jpg"))
        response = self.client.post("/api/ecommerce/scan-clothing-root", json={"path": folder, "keyword": "旗袍"})
        self.assertEqual(response.get_json()["garment_count"], 0)

    def test_keyword_does_not_exclude_valid_zero_padded_numbered_images(self):
        folder = os.path.join(self.user_temp.name, "编号优先款")
        os.makedirs(folder)
        for i in range(1, 7):
            self.make_image(os.path.join(folder, f"{i:02d}.jpg"))
        response = self.client.post("/api/ecommerce/scan-clothing-root", json={"path": folder, "keyword": "旗袍拍摄"})
        self.assertEqual(response.get_json()["garment_count"], 1)

    def test_scan_recurses_through_batch_group_folder(self):
        group = os.path.join(self.user_temp.name, "批量")
        os.makedirs(group)
        for garment_name in ("001", "002", "003"):
            folder = os.path.join(group, garment_name)
            os.makedirs(folder)
            for i in range(1, 7):
                self.make_image(os.path.join(folder, f"{i:02d}.jpg"))
        response = self.client.post("/api/ecommerce/scan-clothing-root", json={"path": self.user_temp.name})
        payload = response.get_json()
        self.assertEqual(payload["garment_count"], 3)
        self.assertEqual([g["name"] for g in payload["garments"]], ["批量/001", "批量/002", "批量/003"])

    def test_rerun_prompt_reuses_original_or_uses_replacement(self):
        self.assertEqual(app_module._ecommerce_rerun_prompt("原提示词", ""), "原提示词")
        self.assertEqual(
            app_module._ecommerce_rerun_prompt("原提示词", "盘扣数量必须一致"),
            "盘扣数量必须一致",
        )

    def test_rerun_accepts_one_through_nine_selected_references(self):
        target = os.path.join(self.user_temp.name, 'nine-ref-target.jpg')
        candidate = os.path.join(self.user_temp.name, 'nine-ref-candidate.jpg')
        result_dir = os.path.join(self.user_temp.name, 'nine-ref-results')
        os.makedirs(result_dir)
        self.make_image(target)
        self.make_image(candidate)
        references = []
        for index in range(9):
            path = os.path.join(self.user_temp.name, f'nine-ref-{index + 1}.jpg')
            self.make_image(path, color=(40 + index * 10, 80, 120))
            references.append(path)
        action = {
            'id': 'a1', 'order': 0, 'name': '背面', 'action_image': target, 'prompt': '原提示词',
            'platform': 'runninghub', 'model_key': 'rhart-image-n-g31-flash/image-to-image-2k',
            'endpoint': 'rhart-image-n-g31-flash/image-to-image', 'resolution': '2k',
        }
        batch = {
            'id': 'one-to-nine-references', 'name': '1到9张参考图', 'run_code': 'RUN',
            'output_path': self.user_temp.name, 'result_dirs': {'g1': result_dir},
            'settings': {'samples_per_action': 1, 'qc_enabled': False},
            'template': {'actions': [action]},
            'garments': [{'id': 'g1', 'name': '款式1', 'path': self.user_temp.name, 'images': references[:6]}],
            'tasks': [{'id': 't1', 'garment_id': 'g1', 'garment_name': '款式1', 'action_id': 'a1', 'action_order': 0, 'action_name': '背面', 'state': 'accepted', 'attempts': []}],
            'usage': {},
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {
            'version': 2, 'templates': [], 'batches': [batch], 'waste_scans': [],
        })
        captured_counts = []

        def fake_generate(_batch, _task, garment, _action, _prompt, _attempt):
            captured_counts.append(len(garment.get('images') or []))
            return candidate

        with patch.object(app_module, '_ecommerce_generate_candidate', side_effect=fake_generate):
            for selected in (references[:1], references):
                response = self.client.post('/api/ecommerce/regenerate', json={
                    'batch_id': batch['id'], 'item_id': 'g1-1', 'result_path': result_dir,
                    'reference_images': selected, 'prompt': '', 'count': 1,
                })
                self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(captured_counts, [1, 9])

    def test_detail_repair_prompt_is_generic_and_accepts_optional_correction(self):
        prompt = app_module._ecommerce_detail_repair_prompt()
        self.assertIn("直接通过视觉对比判断真实设计", prompt)
        self.assertIn("材质、硬度观感、光泽、形状、花纹、数量", prompt)
        self.assertNotIn("珍珠", prompt)
        corrected = app_module._ecommerce_detail_repair_prompt("只检查右侧衣襟")
        self.assertIn("本次额外修复要求：只检查右侧衣襟", corrected)

    def test_detail_rerun_prefers_full_resolution_backup_over_preview(self):
        batch = {'id': 'b1', 'output_path': self.user_temp.name, 'run_code': 'RH-NB2-R01'}
        garment = {'id': 'g1', 'name': '旗袍A'}
        task = {'id': 't1', 'garment_name': '旗袍A', 'action_order': 0, 'attempts': []}
        backup_dir = os.path.join(self.user_temp.name, '_生成样本备份', '旗袍A')
        os.makedirs(backup_dir)
        full_path = os.path.join(backup_dir, 'RH-NB2-R01-AI-01.jpg')
        self.make_image(full_path)
        preview_path = app_module._ecommerce_task_preview_path(batch, task)
        os.makedirs(os.path.dirname(preview_path), exist_ok=True)
        self.make_image(preview_path)
        self.assertEqual(app_module._ecommerce_find_rerun_source(batch, task, garment, 1), full_path)

    def test_rerun_model_override_uses_server_whitelist(self):
        original = {'platform': 'runninghub', 'model_key': 'old', 'action_image': '/tmp/a.jpg'}
        changed = app_module._ecommerce_apply_rerun_model(original, {
            'platform': 'runninghub',
            'model_key': 'rhart-image-n-pro/edit-4k',
            'aspect_ratio': '3:4',
            'endpoint': 'malicious-endpoint',
        })
        self.assertEqual(changed['endpoint'], 'rhart-image-n-pro/edit')
        self.assertEqual(changed['resolution'], '4k')
        self.assertEqual(changed['channel'], 'low-cost')
        with self.assertRaises(ValueError):
            app_module._ecommerce_apply_rerun_model(original, {
                'platform': 'runninghub', 'model_key': 'not-allowed', 'aspect_ratio': '3:4'
            })

    def test_rerun_hk_gpt_model_maps_requested_ratio_to_size(self):
        changed = app_module._ecommerce_apply_rerun_model({}, {
            'platform': 'oaihk', 'model_key': 'gpt-image-2/4k', 'aspect_ratio': '2:3'
        })
        self.assertTrue(changed['is_gpt_image'])
        self.assertEqual(changed['size'], app_module.ECOMMERCE_GPT_SIZES['4k']['2:3'])

    def test_local_image_thumbnail_is_small_jpeg(self):
        source = os.path.join(self.user_temp.name, 'large-reference.jpg')
        Image.new('RGB', (600, 900), (30, 80, 120)).save(source, 'JPEG')
        response = self.client.get('/api/ecommerce/local-image', query_string={
            'path': source, 'thumb': '1', 'max': '200'
        })
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(response.mimetype, 'image/jpeg')
        with Image.open(io.BytesIO(response.data)) as thumbnail:
            self.assertEqual(thumbnail.size, (133, 200))

    def test_rerun_reference_crop_preserves_ratio_and_original(self):
        source = os.path.join(self.user_temp.name, 'portrait-reference.jpg')
        Image.new('RGB', (600, 900), (40, 90, 140)).save(source, 'JPEG')
        with patch.object(app_module, '_ecommerce_batch_snapshot', return_value={
            'id': 'b1', 'output_path': self.user_temp.name
        }):
            response = self.client.post('/api/ecommerce/crop-reference', json={
                'batch_id': 'b1', 'source': source,
                'x': 0.2, 'y': 0.2, 'width': 0.5, 'height': 0.5,
            })
        self.assertEqual(response.status_code, 200, response.get_json())
        target = response.get_json()['path']
        with Image.open(source) as original:
            self.assertEqual(original.size, (600, 900))
        with Image.open(target) as cropped:
            self.assertEqual(cropped.size, (300, 450))

    def test_rerun_reference_crop_rejects_changed_aspect_ratio(self):
        source = os.path.join(self.user_temp.name, 'no-free-crop.jpg')
        self.make_image(source)
        response = self.client.post('/api/ecommerce/crop-reference', json={
            'source': source, 'x': 0.1, 'y': 0.1, 'width': 0.5, 'height': 0.4,
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn('保持原图比例', response.get_json()['error'])

    def test_system_preview_opens_validated_local_images_in_preview(self):
        first = os.path.join(self.user_temp.name, 'preview-1.jpg')
        second = os.path.join(self.user_temp.name, 'preview-2.jpg')
        self.make_image(first)
        self.make_image(second)
        with patch.object(app_module.subprocess, 'Popen') as popen:
            response = self.client.post('/api/ecommerce/open-preview', json={'paths': [first, second]})
        self.assertEqual(response.status_code, 200, response.get_json())
        command = popen.call_args.args[0]
        self.assertEqual(command[:4], ['open', '-n', '-a', 'Preview'])
        self.assertEqual(command[4:], [first, second])

    def test_running_batch_settings_cannot_change_without_pause(self):
        with patch.object(app_module, '_ecommerce_batch_snapshot', return_value={'id': 'b1', 'status': 'running'}):
            response = self.client.patch('/api/ecommerce/batches/b1/settings', json={'qc_enabled': False})
        self.assertEqual(response.status_code, 409)

    def test_task_identity_rejects_cross_garment_mix(self):
        batch = {'id': 'b1'}
        task = {'id': 't1', 'garment_id': 'g1', 'action_id': 'a1', 'action_order': 0}
        garment = {'id': 'g2', 'images': ['1', '2', '3', '4', '5', '6']}
        action = {'id': 'a1'}
        with self.assertRaisesRegex(RuntimeError, '身份校验失败'):
            app_module._ecommerce_verify_task_identity(batch, task, garment, action)

    def test_waste_scan_upserts_same_batch_and_preserves_first_count(self):
        action = {'id': 'a1', 'order': 0, 'platform': 'runninghub', 'model_key': 'nano/4k', 'endpoint': 'nano', 'resolution': '4k', 'channel': 'low-cost'}
        batch = {
            'id': 'b1', 'name': '模型对比', 'template': {'actions': [action]},
            'settings': {'qc_enabled': False}, 'usage': {'runninghub_billed_cny': 3.0},
            'tasks': [
                {'id': f't{i}', 'action_id': 'a1', 'action_order': 0, 'state': 'accepted', 'accepted_path': f'/tmp/{i}.jpg', 'attempts': []}
                for i in range(10)
            ],
        }
        first = app_module._ecommerce_record_waste_scan(batch, [{'action_id': 'a1'}] * 3)
        second = app_module._ecommerce_record_waste_scan(batch, [{'action_id': 'a1'}] * 2)
        store = app_module._ecommerce_load_store()
        rows = [r for r in store['waste_scans'] if r['batch_id'] == 'b1']
        self.assertEqual(len(rows), 1)
        self.assertEqual(first['first_deleted'], 3)
        self.assertEqual(second['first_deleted'], 3)
        self.assertEqual(second['current_deleted'], 2)
        self.assertEqual(second['waste_rate'], 20.0)
        self.assertEqual(second['scan_count'], 2)

    def test_batch_accepts_enterprise_concurrency_up_to_100(self):
        self.assertEqual(app_module.ECOMMERCE_MAX_CONCURRENCY, 100)

    def test_rerun_ui_accepts_100_and_explains_platform_limits(self):
        script_path = os.path.join(os.path.dirname(app_module.__file__), 'static', 'js', 'app.js')
        with open(script_path, 'r', encoding='utf-8') as handle:
            script = handle.read()
        self.assertIn('id="ecommerce-rerun-concurrency" type="number" min="1" max="100"', script)
        self.assertIn('Math.min(100, selectedCount || 1)', script)
        self.assertIn('RH企业线路官方上限100', script)
        self.assertIn('HK未公布固定上限', script)

    def test_rerun_attempt_ids_do_not_overwrite_each_other(self):
        batch = {'tasks': [{'id': 'task-1', 'attempts': []}]}
        app_module._ecommerce_sync_attempt(batch, 'task-1', {'id': 'rerun-a', 'number': 99, 'archived_path': '/a.jpg'})
        app_module._ecommerce_sync_attempt(batch, 'task-1', {'id': 'rerun-b', 'number': 99, 'archived_path': '/b.jpg'})
        attempts = batch['tasks'][0]['attempts']
        self.assertEqual(len(attempts), 2)
        self.assertEqual({row['id'] for row in attempts}, {'rerun-a', 'rerun-b'})

    def test_29_out_of_order_rerun_archives_stay_in_bound_garment_folders(self):
        candidates_root = os.path.join(self.user_temp.name, '乱序候选')
        results_root = os.path.join(self.user_temp.name, '乱序结果')
        cache_root = os.path.join(self.user_temp.name, '乱序缓存')
        os.makedirs(candidates_root)
        garments = []
        tasks = []
        result_dirs = {}
        candidates = {}
        for index in range(29):
            garment_id = f'g-{index:02d}'
            garment_name = f'服装{index:02d}'
            result_dir = os.path.join(results_root, garment_name)
            candidate = os.path.join(candidates_root, f'{index:02d}.jpg')
            self.make_image(candidate, color=(index * 7 % 255, 80, 120))
            garments.append({'id': garment_id, 'name': garment_name, 'images': []})
            tasks.append({'id': f't-{index:02d}', 'garment_id': garment_id, 'action_order': index % 11, 'action_name': f'动作{index % 11 + 1}'})
            result_dirs[garment_id] = result_dir
            candidates[garment_id] = candidate
        batch = {
            'id': 'rerun-out-of-order', 'run_code': 'RH-NB2-LC-4K-R01',
            'output_path': cache_root, 'garments': garments, 'tasks': tasks,
            'result_dirs': result_dirs, 'settings': {},
        }

        def archive(index):
            # 故意让靠后的任务先返回，验证归档不依赖完成顺序。
            time.sleep((28 - index) * 0.0005)
            task = tasks[index]
            return task['garment_id'], app_module._ecommerce_archive_sample(
                batch, task, candidates[task['garment_id']], 1, 1,
            )

        with ThreadPoolExecutor(max_workers=29) as pool:
            futures = [pool.submit(archive, index) for index in range(29)]
            archived = [future.result() for future in as_completed(futures)]
        self.assertEqual(len(archived), 29)
        for garment_id, path in archived:
            self.assertEqual(os.path.dirname(path), os.path.realpath(result_dirs[garment_id]))
            self.assertTrue(os.path.isfile(path))

    def test_global_no_qc_runner_processes_tasks_across_garments(self):
        candidate_dir = os.path.join(self.user_temp.name, 'candidates')
        os.makedirs(candidate_dir)
        actions = []
        garments = []
        tasks = []
        for index in range(2):
            action = {'id': f'a{index}', 'order': index, 'name': f'动作{index}', 'action_image': __file__, 'prompt': '换装'}
            garment = {'id': f'g{index}', 'name': f'服装{index}', 'path': self.user_temp.name, 'images': [__file__] * 6, 'order': index}
            task = {'id': f't{index}', 'order': index, 'garment_id': garment['id'], 'garment_name': garment['name'], 'action_id': action['id'], 'action_order': index, 'action_name': action['name'], 'state': 'pending', 'attempts': []}
            actions.append(action); garments.append(garment); tasks.append(task)
        batch = {'id': 'global1', 'name': '全局并发', 'status': 'running', 'output_path': self.user_temp.name, 'template': {'actions': actions}, 'garments': garments, 'tasks': tasks, 'settings': {'qc_enabled': False, 'concurrency': 100, 'samples_per_action': 1}, 'usage': {}}
        app_module._ecommerce_save_store({'version': 2, 'templates': [], 'batches': [batch], 'waste_scans': []})

        def fake_generate(_batch, task, _garment, _action, _prompt, _attempt):
            path = os.path.join(candidate_dir, f"{task['id']}.jpg")
            self.make_image(path)
            return path

        with patch.object(app_module, '_ecommerce_generate_candidate', side_effect=fake_generate), patch.object(
            app_module, '_ecommerce_archive_sample', side_effect=lambda _b, task, _p, _n, _total: f"/archive/{task['id']}.jpg"
        ):
            app_module._ecommerce_run_batch_no_qc_global('global1')
        updated = next(b for b in app_module._ecommerce_load_store()['batches'] if b['id'] == 'global1')
        self.assertEqual(updated['status'], 'completed')
        self.assertEqual([t['state'] for t in updated['tasks']], ['accepted', 'accepted'])
        self.assertEqual([t['accepted_path'] for t in updated['tasks']], ['/archive/t0.jpg', '/archive/t1.jpg'])

    def test_single_garment_folder_with_six_images_is_a_valid_run_root(self):
        folder = self.make_garment("单套测试款")
        response = self.client.post("/api/ecommerce/scan-clothing-root", json={"path": folder})
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["garment_count"], 1)
        self.assertEqual(payload["garments"][0]["name"], "单套测试款")
        self.assertEqual(len(payload["garments"][0]["images"]), 6)

    def test_external_volume_paths_are_allowed_for_user_selected_materials(self):
        self.assertTrue(app_module._is_allowed_user_storage_path("/Volumes/外置固态/旗袍/动作替换参考图"))
        self.assertFalse(app_module._is_allowed_user_storage_path("/Volumes"))
        self.assertFalse(app_module._is_allowed_user_storage_path("/etc"))

    def test_qc_builds_two_reusable_reference_sheets(self):
        garment_folder = self.make_garment("拼图款")
        garment = {"id": "g1", "name": "拼图款", "path": garment_folder, "images": [os.path.join(garment_folder, f"{i}-参考.jpg") for i in range(1, 7)]}
        batch = {"id": "b1", "name": "拼图测试", "output_path": self.user_temp.name, "garments": [garment]}
        profile = {"critical_regions": [{"name": "领口", "reference_index": 1, "box_xyxy": [200, 100, 800, 600]}]}
        assets = app_module._ecommerce_build_qc_reference_assets(batch, garment, profile)
        self.assertTrue(os.path.isfile(assets["overview"]))
        self.assertTrue(os.path.isfile(assets["details"]))
        with Image.open(assets["overview"]) as image:
            self.assertEqual(image.size, (1152, 1152))
        with Image.open(assets["details"]) as image:
            self.assertEqual(image.size, (1152, 768))

    def test_candidate_qc_uses_only_two_sheets_plus_candidate(self):
        garment_folder = self.make_garment("三图质检款")
        candidate = os.path.join(self.user_temp.name, "qc-three.jpg")
        self.make_image(candidate)
        garment = {"id": "g1", "name": "三图质检款", "path": garment_folder, "images": [os.path.join(garment_folder, f"{i}-参考.jpg") for i in range(1, 7)]}
        batch = {"id": "ecbatch_three_images", "name": "三图质检", "output_path": self.user_temp.name, "settings": {"qc_model": "gemini-2.5-pro", "qc_threshold": 85}, "garments": [garment], "tasks": [], "usage": {}}
        profile = {"garment_summary": "测试", "critical_regions": []}
        garment["profile"] = profile
        garment["qc_assets"] = app_module._ecommerce_build_qc_reference_assets(batch, garment, profile)
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})
        captured = {}

        def fake_vision(model, prompt, sources, timeout=240):
            captured["sources"] = sources
            return {"verdict": "pass", "overall_score": 95, "scores": {"collar": 95, "placket": 95}, "critical_errors": []}

        with patch.object(app_module, "_ecommerce_vision_json", side_effect=fake_vision):
            report = app_module._ecommerce_qc_candidate(batch, garment, {}, candidate)
        self.assertEqual(len(captured["sources"]), 3)
        self.assertEqual(report["input_image_count"], 3)
        self.assertEqual(report["reference_mode"], "profile_plus_two_sheets")
        self.assertTrue(report["passed"])

    def test_default_profile_mode_builds_local_sheets_without_ai_call(self):
        garment_folder = self.make_garment("零调用建档款")
        garment = {"id": "g1", "name": "零调用建档款", "path": garment_folder, "images": [os.path.join(garment_folder, f"{i}-参考.jpg") for i in range(1, 7)]}
        batch = {
            "id": "ecbatch_visual_profile", "name": "本地视觉建档", "output_path": self.user_temp.name,
            "settings": {"profile_mode": "visual_sheets", "qc_model": "gemini-2.5-pro"},
            "garments": [garment], "tasks": [], "usage": {"profile_calls": 0},
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})
        with patch.object(app_module, "_ecommerce_vision_profile_line") as profile_call:
            profile = app_module._ecommerce_get_garment_profile(batch["id"], garment["id"])
        profile_call.assert_not_called()
        saved = app_module._ecommerce_batch_snapshot(batch["id"])
        saved_garment = saved["garments"][0]
        self.assertEqual(profile["profile_mode"], "visual_sheets")
        self.assertEqual(saved["usage"]["profile_calls"], 0)
        self.assertTrue(os.path.isfile(saved_garment["qc_assets"]["overview"]))
        self.assertTrue(os.path.isfile(saved_garment["qc_assets"]["details"]))

    def test_generation_reference_uses_cached_data_uri_without_image_host(self):
        source = os.path.join(self.user_temp.name, "reference.jpg")
        self.make_image(source)
        app_module.ecommerce_reference_data_cache.clear()
        with patch.object(app_module.requests, "post") as post:
            first = app_module._ecommerce_upload_public_reference("batch-1", source)
            second = app_module._ecommerce_upload_public_reference("batch-1", source)
        self.assertTrue(first.startswith("data:image/jpeg;base64,"))
        self.assertEqual(first, second)
        post.assert_not_called()

    def test_runninghub_reference_uses_official_upload_and_cached_download_url(self):
        source = os.path.join(self.user_temp.name, "rh-upload.jpg")
        self.make_image(source)
        batch = {"id": "batch-rh-upload", "reference_cache": {}, "tasks": [], "garments": []}
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})
        app_module.save_json("model_config.json", {
            "rh_api_key": "enterprise-key",
            "rh_base_url": "https://www.runninghub.ai/openapi/v2",
        })
        response = Mock(status_code=200)
        response.json.return_value = {
            "code": 0, "message": "success",
            "data": {"download_url": "https://rh-images.xiaoyaoyou.com/input/test.jpg"},
        }
        with patch.object(app_module, "_validate_url", return_value=(True, None, "1.2.3.4")), \
             patch.object(app_module.requests, "post", return_value=response) as post:
            first = app_module._ecommerce_upload_runninghub_reference(batch["id"], source)
            second = app_module._ecommerce_upload_runninghub_reference(batch["id"], source)
        self.assertEqual(first, "https://rh-images.xiaoyaoyou.com/input/test.jpg")
        self.assertEqual(first, second)
        self.assertEqual(post.call_count, 1)
        self.assertTrue(post.call_args.args[0].endswith("/media/upload/binary"))

    def test_action_folder_import_is_naturally_sorted_and_capped_at_twenty(self):
        action_root = os.path.join(self.user_temp.name, "动作组")
        os.makedirs(action_root)
        for number in range(1, 23):
            self.make_image(os.path.join(action_root, f"动作{number}.jpg"))
        response = self.client.post("/api/ecommerce/scan-action-root", json={"path": action_root})
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["action_count"], 20)
        self.assertEqual(payload["total_found"], 22)
        self.assertTrue(payload["truncated"])
        self.assertEqual(payload["actions"][0]["name"], "动作1")
        self.assertEqual(payload["actions"][1]["name"], "动作2")
        self.assertEqual(payload["actions"][-1]["name"], "动作20")

    def test_runninghub_template_preserves_provider_resolution_and_channel(self):
        action_image = os.path.join(self.user_temp.name, "rh-action.jpg")
        self.make_image(action_image)
        response = self.client.post(
            "/api/ecommerce/templates",
            json={"name": "RH官方4K", "actions": [{
                "name": "正面", "action_image": action_image, "prompt": "换装",
                "platform": "runninghub",
                "model_key": "rhart-image-g-2-official/image-to-image-4k",
                "model_id": "rhart-image-g-2-official/image-to-image",
                "endpoint": "rhart-image-g-2-official/image-to-image",
                "resolution": "4k", "aspect_ratio": "auto", "channel": "official",
                "resolution_guaranteed": True, "max_images": 10, "price": "¥0.19/张",
            }]},
        )
        self.assertEqual(response.status_code, 201)
        action = response.get_json()["template"]["actions"][0]
        self.assertEqual(action["platform"], "runninghub")
        self.assertEqual(action["resolution"], "4k")
        self.assertEqual(action["channel"], "official")
        self.assertEqual(action["max_images"], 10)

    def test_runninghub_candidate_submit_uses_seven_images_and_resumes_task(self):
        garment_folder = self.make_garment("RH六图款")
        action_image = os.path.join(self.user_temp.name, "rh-action.jpg")
        self.make_image(action_image)
        garment = {"id": "g1", "name": "RH六图款", "path": garment_folder, "images": [os.path.join(garment_folder, f"{i}-参考.jpg") for i in range(1, 7)]}
        action = {
            "platform": "runninghub", "action_image": action_image,
            "endpoint": "rhart-image-g-2-official/image-to-image", "resolution": "4k",
            "aspect_ratio": "auto", "max_images": 10,
        }
        task = {"id": "t1", "garment_name": "RH六图款", "action_order": 0}
        batch = {"id": "b1", "status": "running", "output_path": self.user_temp.name, "usage": {}, "tasks": [dict(task, attempts=[])]}
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})
        image_buffer = io.BytesIO()
        Image.new("RGB", (64, 96), (10, 20, 30)).save(image_buffer, "PNG")
        encoded = base64.b64encode(image_buffer.getvalue()).decode("ascii")
        calls = []

        def fake_route(_route, _path, body):
            calls.append(body)
            if body["action"] == "submit":
                self.assertEqual(len(body["params"]["imageUrls"]), 7)
                self.assertEqual(body["params"]["resolution"], "4k")
                self.assertNotIn("aspectRatio", body["params"])
                return {"taskId": "rh-task-1", "status": "PENDING"}, 200
            return {"status": "SUCCESS", "results": [{"b64_json": encoded}]}, 200

        attempt = {"number": 1, "request_id": "", "status": "preparing"}
        with patch.object(app_module, "_ecommerce_upload_runninghub_reference", return_value="https://rh-images.xiaoyaoyou.com/input/ref.jpg"), \
             patch.object(app_module, "_ecommerce_internal_route_data", side_effect=fake_route):
            candidate = app_module._ecommerce_generate_candidate(batch, task, garment, action, "测试", attempt)
        self.assertTrue(os.path.isfile(candidate))
        self.assertEqual(attempt["request_id"], "rh-task-1")
        self.assertEqual([call["action"] for call in calls], ["submit", "query"])

    def test_target_only_runninghub_submits_exactly_one_image_to_original_edit_endpoint(self):
        action_image = os.path.join(self.user_temp.name, "target-only-rh.jpg")
        self.make_image(action_image)
        garment = {"id": "g1", "name": "单图提示词", "images": [], "virtual": True}
        action = {
            "id": "a1", "order": 0, "platform": "runninghub", "action_image": action_image,
            "endpoint": "rhart-image-n-g31-flash/image-to-image", "resolution": "2k",
            "aspect_ratio": "auto", "max_images": 10,
        }
        task = {"id": "t1", "garment_name": "单图提示词", "action_order": 0}
        batch = {
            "id": "target-only-rh", "generation_mode": "target_only", "status": "running",
            "output_path": self.user_temp.name, "usage": {}, "tasks": [dict(task, attempts=[])],
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 2, "templates": [], "batches": [batch], "waste_scans": []})
        image_buffer = io.BytesIO()
        Image.new("RGB", (64, 96), (10, 20, 30)).save(image_buffer, "PNG")
        encoded = base64.b64encode(image_buffer.getvalue()).decode("ascii")
        uploads, calls = [], []

        def fake_upload(_batch_id, source):
            uploads.append(source)
            return "https://rh-images.xiaoyaoyou.com/input/only-target.jpg"

        def fake_route(_route, _path, body):
            calls.append(body)
            if body["action"] == "submit":
                self.assertEqual(body["model_id"], "rhart-image-n-g31-flash/image-to-image")
                self.assertEqual(body["params"]["imageUrls"], ["https://rh-images.xiaoyaoyou.com/input/only-target.jpg"])
                return {"taskId": "target-only-task"}, 200
            return {"status": "SUCCESS", "results": [{"b64_json": encoded}]}, 200

        attempt = {"number": 1, "request_id": "", "status": "preparing"}
        with patch.object(app_module, "_ecommerce_upload_runninghub_reference", side_effect=fake_upload), \
             patch.object(app_module, "_ecommerce_internal_route_data", side_effect=fake_route):
            candidate = app_module._ecommerce_generate_candidate(batch, task, garment, action, "测试", attempt)
        self.assertTrue(os.path.isfile(candidate))
        self.assertEqual(uploads, [action_image])
        self.assertEqual(attempt["mode"], "target-only-edit")
        self.assertEqual([call["action"] for call in calls], ["submit", "query"])

    def test_garment_prompt_runninghub_submits_each_source_as_one_independent_edit(self):
        source = os.path.join(self.user_temp.name, "garment-prompt-source.jpg")
        self.make_image(source)
        garment = {"id": "g-source", "name": "来源目录", "images": [source], "prompt_image_group": True}
        action = {
            "id": "a-source", "garment_id": "g-source", "order": 0,
            "platform": "runninghub", "action_image": source,
            "endpoint": "rhart-image-n-g31-flash/image-to-image", "resolution": "2k",
            "aspect_ratio": "auto", "max_images": 10,
        }
        task = {"id": "t-source", "garment_id": "g-source", "garment_name": "来源目录", "action_order": 0}
        batch = {
            "id": "garment-prompt-rh", "generation_mode": "garment_prompt", "status": "running",
            "output_path": self.user_temp.name, "usage": {}, "tasks": [dict(task, attempts=[])],
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 2, "templates": [], "batches": [batch], "waste_scans": []})
        image_buffer = io.BytesIO()
        Image.new("RGB", (64, 96), (10, 20, 30)).save(image_buffer, "PNG")
        encoded = base64.b64encode(image_buffer.getvalue()).decode("ascii")
        uploads = []

        def fake_upload(_batch_id, uploaded_source):
            uploads.append(uploaded_source)
            return "https://rh-images.xiaoyaoyou.com/input/garment.jpg"

        def fake_route(_route, _path, body):
            if body["action"] == "submit":
                self.assertEqual(body["params"]["imageUrls"], ["https://rh-images.xiaoyaoyou.com/input/garment.jpg"])
                return {"taskId": "garment-prompt-task"}, 200
            return {"status": "SUCCESS", "results": [{"b64_json": encoded}]}, 200

        attempt = {"number": 1, "request_id": "", "status": "preparing"}
        with patch.object(app_module, "_ecommerce_upload_runninghub_reference", side_effect=fake_upload), \
             patch.object(app_module, "_ecommerce_internal_route_data", side_effect=fake_route):
            candidate = app_module._ecommerce_generate_candidate(batch, task, garment, action, "统一提示词", attempt)
        self.assertTrue(os.path.isfile(candidate))
        self.assertEqual(uploads, [source])
        self.assertEqual(attempt["mode"], "garment-prompt-edit")

    def test_target_only_gpt_uses_edits_with_exactly_one_image(self):
        action_image = os.path.join(self.user_temp.name, "target-only-gpt.jpg")
        self.make_image(action_image)
        garment = {"id": "g1", "name": "单图提示词", "images": [], "virtual": True}
        action = {
            "id": "a1", "order": 0, "platform": "oaihk", "action_image": action_image,
            "is_gpt_image": True, "model_id": "gpt-image-2", "model_key": "gpt-image-2/2k",
            "size": "1024x1536", "quality": "medium", "short_edge": 1024,
        }
        task = {"id": "t1", "garment_name": "单图提示词", "action_order": 0}
        batch = {
            "id": "target-only-gpt", "generation_mode": "target_only", "status": "running",
            "output_path": self.user_temp.name, "usage": {}, "tasks": [dict(task, attempts=[])],
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 2, "templates": [], "batches": [batch], "waste_scans": []})
        image_buffer = io.BytesIO()
        Image.new("RGB", (64, 96), (20, 30, 40)).save(image_buffer, "PNG")
        encoded = base64.b64encode(image_buffer.getvalue()).decode("ascii")
        captured = {}

        def fake_route(_route, _path, body):
            captured.update(body)
            return {"data": [{"b64_json": encoded}]}, 200

        with patch.object(app_module, "_ecommerce_internal_route_data", side_effect=fake_route):
            candidate = app_module._ecommerce_generate_candidate(
                batch, task, garment, action, "测试", {"number": 1, "request_id": ""}
            )
        self.assertTrue(os.path.isfile(candidate))
        self.assertEqual(captured["action"], "edits")
        self.assertEqual(len(captured["image_base64_list"]), 1)

    def test_output_spec_rejects_fake_4k_and_checks_auto_ratio(self):
        action_image = os.path.join(self.user_temp.name, "spec-action.jpg")
        candidate = os.path.join(self.user_temp.name, "fake-4k.jpg")
        self.make_image(action_image)
        Image.new("RGB", (1024, 1536), (30, 40, 50)).save(candidate, "JPEG")
        report = app_module._ecommerce_candidate_output_spec(candidate, {
            "action_image": action_image, "model_key": "gpt-image-2/4k", "aspect_ratio": "auto"
        })
        self.assertFalse(report["passed"])
        self.assertFalse(report["resolution_ok"])
        self.assertTrue(report["ratio_ok"])
        self.assertEqual(report["requested_resolution"], "4k")

    def test_candidate_cache_is_isolated_between_batches(self):
        image_buffer = io.BytesIO()
        Image.new("RGB", (64, 96), (10, 20, 30)).save(image_buffer, "PNG")
        item = {"b64_json": base64.b64encode(image_buffer.getvalue()).decode("ascii")}
        task = {"garment_name": "同一服装", "action_order": 0}
        first = app_module._ecommerce_download_candidate(
            {"id": "batch-a", "name": "批次A", "output_path": self.user_temp.name}, task, 1, item
        )
        second = app_module._ecommerce_download_candidate(
            {"id": "batch-b", "name": "批次B", "output_path": self.user_temp.name}, task, 1, item
        )
        self.assertNotEqual(first, second)
        self.assertTrue(os.path.isfile(first))
        self.assertTrue(os.path.isfile(second))

    def test_hk_gpt_auto_ratio_keeps_requested_4k_tier(self):
        action_image = os.path.join(self.user_temp.name, "gpt-auto-action.jpg")
        Image.new("RGB", (2000, 3000), (20, 30, 40)).save(action_image, "JPEG")
        size = app_module._ecommerce_gpt_auto_size({
            "action_image": action_image,
            "model_key": "gpt-image-2/4k",
            "aspect_ratio": "auto",
            "size": "auto",
        })
        self.assertEqual(size, "2336x3504")

    def test_vision_json_parser_repairs_missing_and_trailing_commas(self):
        broken = '''```json
        {"garment_summary":"旗袍"
         "colors":["白色",],
         "frog_buttons":{"present":true}}
        ```'''
        parsed = app_module._ecommerce_parse_json_text(broken)
        self.assertEqual(parsed["garment_summary"], "旗袍")
        self.assertEqual(parsed["colors"], ["白色"])
        self.assertTrue(parsed["frog_buttons"]["present"])

    def test_enterprise_key_error_is_configuration_not_transport_retry(self):
        self.assertTrue(app_module._ecommerce_generation_needs_configuration(
            "Access Denied: restricted to Enterprise-Shared API Keys only"
        ))
        self.assertFalse(app_module._ecommerce_generation_needs_configuration("timeout"))

    def test_runninghub_preflight_uses_price_preview_without_creating_task(self):
        price_response = Mock(status_code=200)
        price_response.json.return_value = {
            "errorCode": "", "errorMessage": "", "estimatedPrice": 0.19,
            "currency": "CNY", "isFreeThisCall": False,
        }
        account_response = Mock(status_code=200)
        account_response.json.return_value = {"code": 0, "msg": "success", "data": {
            "remainMoney": "88.50", "remainCoins": "123", "currentTaskCounts": "0", "currency": "CNY", "apiType": "SHARED",
        }}
        with patch.object(app_module, "_validate_url", return_value=(True, None, "1.2.3.4")), \
             patch.object(app_module.requests, "post", side_effect=[price_response, account_response]) as post:
            result = self.client.post("/api/rh-preflight", json={
                "api_key": "enterprise-test-key",
                "base_url": "https://www.runninghub.ai/openapi/v2",
                "model_id": "rhart-image-g-2-official/image-to-image",
                "resolution": "4k",
            })
        self.assertEqual(result.status_code, 200)
        payload = result.get_json()
        self.assertTrue(payload["success"])
        self.assertFalse(payload["charged"])
        self.assertFalse(payload["task_created"])
        self.assertEqual(payload["key_type_verified"], "enterprise-shared")
        self.assertEqual(payload["account"]["remain_money"], "88.50")
        self.assertEqual(payload["account"]["api_type"], "SHARED")
        called_url = post.call_args_list[0].args[0]
        called_body = post.call_args_list[0].kwargs["json"]
        self.assertIn("/price-preview/rhart-image-g-2-official/image-to-image", called_url)
        self.assertEqual(called_body["resolution"], "4k")
        self.assertEqual(called_body["quality"], "high")
        self.assertEqual(len(called_body["imageUrls"]), 1)

    def test_runninghub_legacy_cn_base_is_migrated_and_persisted_as_ai(self):
        app_module.save_json("model_config.json", {
            "rh_api_key": "enterprise-key",
            "rh_base_url": "https://www.runninghub.cn/openapi/v2",
        })

        response = self.client.get("/api/model-config")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["rh_base_url"], app_module.DEFAULT_RH_BASE_URL)
        saved = app_module.load_json("model_config.json")
        self.assertEqual(saved["rh_base_url"], app_module.DEFAULT_RH_BASE_URL)

    def test_runninghub_key_can_be_replaced_but_is_only_returned_masked(self):
        app_module.save_json("model_config.json", {
            "rh_api_key": "old-enterprise-key-1234",
            "rh_base_url": app_module.DEFAULT_RH_BASE_URL,
        })
        response = self.client.put("/api/model-config", json={
            "rh_api_key": "new-enterprise-key-9876",
            "rh_base_url": app_module.DEFAULT_RH_BASE_URL,
        })
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("new-enterprise-key-9876", response.get_data(as_text=True))
        self.assertIn("****", response.get_json()["rh_api_key"])
        self.assertEqual(app_module.load_json("model_config.json")["rh_api_key"], "new-enterprise-key-9876")

        masked = response.get_json()["rh_api_key"]
        self.client.put("/api/model-config", json={"rh_api_key": masked})
        self.assertEqual(app_module.load_json("model_config.json")["rh_api_key"], "new-enterprise-key-9876")

    def test_runninghub_proxy_never_sends_request_to_legacy_cn_domain(self):
        app_module.save_json("model_config.json", {
            "rh_api_key": "enterprise-key",
            "rh_base_url": app_module.DEFAULT_RH_BASE_URL,
        })
        upstream = Mock(status_code=200)
        upstream.json.return_value = {"taskId": "rh-new-domain", "status": "PENDING"}

        with patch.object(app_module.requests, "post", return_value=upstream) as post:
            response = self.client.post("/api/rh-proxy", json={
                "action": "submit",
                "base_url": "https://runninghub.cn/openapi/v2",
                "model_id": "rhart-image-n-g31-flash/image-to-image-4k",
                "params": {"imageUrls": ["https://example.com/ref.jpg"], "prompt": "test"},
            })

        self.assertEqual(response.status_code, 200)
        self.assertTrue(post.call_args.args[0].startswith(app_module.DEFAULT_RH_BASE_URL + "/"))
        self.assertNotIn("runninghub.cn", post.call_args.args[0])

    def test_runninghub_preflight_explains_non_enterprise_key(self):
        response = Mock(status_code=403)
        response.json.return_value = {
            "code": 1014,
            "errorMessage": "Access Denied: Standard Model API is restricted to Enterprise-Shared API Keys only.",
        }
        with patch.object(app_module, "_validate_url", return_value=(True, None, "1.2.3.4")), \
             patch.object(app_module.requests, "post", return_value=response):
            result = self.client.post("/api/rh-preflight", json={
                "api_key": "consumer-key",
                "base_url": "https://www.runninghub.ai/openapi/v2",
            })
        self.assertEqual(result.status_code, 403)
        payload = result.get_json()
        self.assertEqual(payload["error_code"], 1014)
        self.assertFalse(payload["charged"])
        self.assertIn("企业级-共享", payload["message"])

    def test_flat_profile_line_parser_keeps_all_qc_fields(self):
        line = "视角=1正全;2正特;3左45特;4右45特;5侧全;6背全|概括=白色刺绣旗袍|领口=中式立领|衣襟=右衽斜襟|扣件=三颗盘扣|拉链=背部一条|袖口=无袖|开叉=双侧开叉|材质=提花缎|花纹=凤凰花鸟|颜色=白色|关键=右襟刺绣|不确定=无"
        profile = app_module._ecommerce_parse_profile_line(line)
        self.assertEqual(profile["garment_summary"], "白色刺绣旗袍")
        self.assertEqual(profile["fasteners"], "三颗盘扣")
        self.assertEqual(profile["pattern"], "凤凰花鸟")

    def test_create_batch_builds_garment_by_action_tasks(self):
        self.make_garment("款A")
        self.make_garment("款B")
        action_image = os.path.join(self.user_temp.name, "动作.jpg")
        self.make_image(action_image)
        template_response = self.client.post(
            "/api/ecommerce/templates",
            json={
                "name": "两个动作",
                "actions": [
                    {"name": "正面", "action_image": action_image, "prompt": "图1动作，图2至图7服装", "platform": "oaihk", "model_key": "fal-ai/banana/v3.1/flash/2k"},
                    {"name": "侧面", "action_image": action_image, "prompt": "保持图1动作并替换服装", "platform": "oaihk", "model_key": "fal-ai/banana/v3.1/flash/2k"},
                ],
            },
        )
        self.assertEqual(template_response.status_code, 201)
        template_id = template_response.get_json()["template"]["id"]
        response = self.client.post(
            "/api/ecommerce/batches",
            json={
                "template_id": template_id,
                "clothing_root": self.user_temp.name,
                "output_path": os.path.join(self.user_temp.name, "输出"),
                "concurrency": 3,
                "qc_model": "gemini-2.5-pro",
            },
        )
        self.assertEqual(response.status_code, 201)
        batch = response.get_json()["batch"]
        self.assertEqual(batch["task_total"], 4)
        self.assertEqual(len(batch["garments"]), 2)
        self.assertEqual(batch["settings"]["max_attempts"], 3)
        self.assertEqual(batch["settings"]["concurrency"], 3)
        self.assertEqual(batch["settings"]["profile_mode"], "visual_sheets")

    def test_create_batch_accepts_current_target_images_without_saved_group(self):
        garment_folder = self.make_garment("直接运行款")
        target_image = os.path.join(self.user_temp.name, "目标图.jpg")
        self.make_image(target_image)
        response = self.client.post(
            "/api/ecommerce/batches",
            json={
                "template_name": "本次运行目标图",
                "actions": [{
                    "name": "目标图1",
                    "action_image": target_image,
                    "prompt": "图1保持不变，使用图2至图7替换服装",
                    "platform": "runninghub",
                    "model_key": "rhart-image-n-g31-flash/image-to-image-4k",
                    "endpoint": "rhart-image-n-g31-flash/image-to-image",
                    "resolution": "4k",
                    "aspect_ratio": "auto",
                }],
                "clothing_root": garment_folder,
                "output_path": os.path.join(self.user_temp.name, "输出"),
            },
        )
        self.assertEqual(response.status_code, 201)
        batch = response.get_json()["batch"]
        self.assertEqual(batch["task_total"], 1)
        self.assertTrue(batch["template"]["inline_snapshot"])
        self.assertEqual(batch["template"]["actions"][0]["aspect_ratio"], "auto")
        saved = app_module.load_json(app_module.ECOMMERCE_DATA_FILE)
        self.assertEqual(saved.get("templates"), [])

    def test_output_path_probe_really_writes_and_removes_test_file(self):
        destination = os.path.join(self.user_temp.name, '外置成品模拟目录')
        response = self.client.post('/api/ecommerce/check-output-path', json={'path': destination})
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertTrue(response.get_json()['writable'])
        self.assertEqual(os.listdir(destination), [])

    def test_external_permission_error_is_classified_for_macos_guidance(self):
        with patch.object(app_module.os, 'makedirs'), patch.object(
            app_module.tempfile, 'mkstemp', side_effect=PermissionError(errno.EPERM, 'Operation not permitted')
        ), patch.object(app_module, '_ecommerce_macos_storage_helper', return_value=(False, 'denied')):
            result = app_module._ecommerce_probe_writable_directory('/Volumes/外置测试盘/成品')
        self.assertFalse(result['writable'])
        self.assertTrue(result['external_volume'])
        self.assertEqual(result['code'], 'STORAGE_PERMISSION_DENIED')
        self.assertIn('弹窗授权选择', result['hint'])
        self.assertIn('不需要去系统设置里查找Python', result['hint'])

    def test_permission_denied_directory_can_use_macos_compatible_write(self):
        with patch.object(app_module.os, 'makedirs'), patch.object(
            app_module.tempfile, 'mkstemp', side_effect=PermissionError(errno.EPERM, 'Operation not permitted')
        ), patch.object(app_module, '_ecommerce_macos_storage_helper', return_value=(True, '')) as helper:
            result = app_module._ecommerce_probe_writable_directory('/Volumes/外置测试盘/成品')
        self.assertTrue(result['writable'])
        self.assertEqual(result['write_mode'], 'macos_helper')
        self.assertIn('系统兼容写入', result['warning'])
        helper.assert_called_once()

    def test_copy_file_falls_back_to_macos_compatible_write(self):
        source = os.path.join(self.user_temp.name, 'candidate.jpg')
        target = '/Volumes/外置测试盘/成品/AI-01.jpg'
        self.make_image(source)
        with patch.object(app_module.shutil, 'copy2', side_effect=PermissionError(errno.EPERM, 'Operation not permitted')), patch.object(
            app_module, '_ecommerce_macos_storage_helper', return_value=(True, '')
        ) as helper:
            self.assertEqual(app_module._ecommerce_copy_file(source, target), target)
        helper.assert_called_once_with('copy', source, target, os.path.dirname(target))

    def test_unwritable_final_output_blocks_before_batch_is_created(self):
        garment_folder = self.make_garment('外置权限阻止款')
        target_image = os.path.join(self.user_temp.name, '目标.jpg')
        self.make_image(target_image)
        requested = os.path.join(self.user_temp.name, '模拟外置成品')
        real_probe = app_module._ecommerce_probe_writable_directory

        def probe(path, *args, **kwargs):
            if os.path.realpath(path) == os.path.realpath(requested):
                return {'writable': False, 'path': path, 'external_volume': True, 'code': 'STORAGE_PERMISSION_DENIED', 'error': 'Operation not permitted', 'hint': '请授权可移动宗卷'}
            return real_probe(path)

        with patch.object(app_module, '_ecommerce_probe_writable_directory', side_effect=probe):
            response = self.client.post('/api/ecommerce/batches', json={
                'actions': [{'action_image': target_image, 'prompt': '换装', 'platform': 'runninghub'}],
                'garment_images': [os.path.join(garment_folder, '1-参考.jpg')],
                'output_path': self.user_temp.name,
                'final_output_path': requested,
            })
        self.assertEqual(response.status_code, 409, response.get_json())
        self.assertEqual(response.get_json()['code'], 'STORAGE_PERMISSION_DENIED')
        self.assertEqual(app_module._ecommerce_load_store()['batches'], [])

    def test_user_can_explicitly_fallback_to_local_final_output(self):
        garment_folder = self.make_garment('外置回退款')
        target_image = os.path.join(self.user_temp.name, '目标回退.jpg')
        self.make_image(target_image)
        requested = os.path.join(self.user_temp.name, '模拟不可写外置成品')
        real_probe = app_module._ecommerce_probe_writable_directory

        def probe(path, *args, **kwargs):
            if os.path.realpath(path) == os.path.realpath(requested):
                return {'writable': False, 'path': path, 'external_volume': True, 'code': 'STORAGE_PERMISSION_DENIED', 'error': 'Operation not permitted', 'hint': '请授权可移动宗卷'}
            return real_probe(path)

        with patch.object(app_module, '_ecommerce_probe_writable_directory', side_effect=probe):
            response = self.client.post('/api/ecommerce/batches', json={
                'actions': [{'action_image': target_image, 'prompt': '换装', 'platform': 'runninghub'}],
                'garment_images': [os.path.join(garment_folder, '1-参考.jpg')],
                'output_path': self.user_temp.name,
                'final_output_path': requested,
                'allow_final_fallback': True,
            })
        self.assertEqual(response.status_code, 201, response.get_json())
        payload = response.get_json()
        self.assertTrue(payload['batch']['settings']['final_output_fallback'])
        self.assertEqual(payload['batch']['settings']['requested_final_output_path'], requested)
        self.assertIn('_成品输出', payload['batch']['final_output_path'])
        self.assertIn('已按你的确认', payload['warning'])

    def test_macos_compatible_final_output_keeps_selected_directory(self):
        garment_folder = self.make_garment('兼容写入款')
        target_image = os.path.join(self.user_temp.name, '目标兼容.jpg')
        self.make_image(target_image)
        requested = os.path.join(self.user_temp.name, '模拟外置兼容成品')
        real_probe = app_module._ecommerce_probe_writable_directory

        def probe(path, *args, **kwargs):
            if os.path.realpath(path) == os.path.realpath(requested):
                return {
                    'writable': True,
                    'path': path,
                    'external_volume': True,
                    'write_mode': 'macos_helper',
                    'warning': '已启用系统兼容写入',
                }
            return real_probe(path, *args, **kwargs)

        with patch.object(app_module, '_ecommerce_probe_writable_directory', side_effect=probe):
            response = self.client.post('/api/ecommerce/batches', json={
                'actions': [{'action_image': target_image, 'prompt': '换装', 'platform': 'runninghub'}],
                'garment_images': [os.path.join(garment_folder, '1-参考.jpg')],
                'output_path': self.user_temp.name,
                'final_output_path': requested,
            })
        self.assertEqual(response.status_code, 201, response.get_json())
        batch = response.get_json()['batch']
        self.assertEqual(batch['final_output_path'], requested)
        self.assertEqual(batch['settings']['final_output_write_mode'], 'macos_helper')
        self.assertFalse(batch['settings']['final_output_fallback'])

    def test_running_batch_with_all_tasks_archived_is_reconciled_to_completed(self):
        batch = {
            'id': 'ecbatch_reconcile',
            'status': 'running',
            'tasks': [
                {'id': 'task-1', 'state': 'accepted'},
                {'id': 'task-2', 'state': 'manual_review'},
            ],
        }
        self.assertTrue(app_module._ecommerce_reconcile_batch_status(batch))
        self.assertEqual(batch['status'], 'completed')
        self.assertTrue(batch.get('finished_at'))

    def test_submitted_request_is_resumed_without_new_attempt(self):
        garment_folder = self.make_garment("断点款")
        candidate = os.path.join(self.user_temp.name, "candidate.jpg")
        self.make_image(candidate)
        batch_id = "ecbatch_resume"
        task_id = "ectask_resume"
        batch = {
            "id": batch_id,
            "status": "running",
            "output_path": self.user_temp.name,
            "settings": {"max_attempts": 3, "qc_enabled": True},
            "garments": [{"id": "g1", "name": "断点款", "path": garment_folder, "images": [os.path.join(garment_folder, f"{i}-参考.jpg") for i in range(1, 7)]}],
            "template": {"actions": [{"id": "a1", "name": "动作1", "order": 0, "action_image": candidate, "prompt": "测试", "platform": "oaihk"}]},
            "tasks": [{
                "id": task_id, "garment_id": "g1", "garment_name": "断点款", "action_id": "a1", "action_order": 0,
                "action_name": "动作1", "state": "submitted", "accepted_path": "", "manual_review_path": "", "last_error": "",
                "attempts": [{"number": 1, "status": "submitted", "request_id": "existing-request-id", "candidate_path": "", "qc": None}],
            }],
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})

        with patch.object(app_module, "_ecommerce_generate_candidate", return_value=candidate) as generate, \
             patch.object(app_module, "_ecommerce_qc_candidate", return_value={"passed": True, "overall_score": 95, "critical_errors": []}), \
             patch.object(app_module, "_ecommerce_archive_accepted", return_value=candidate):
            app_module._ecommerce_run_task(batch_id, task_id)

        used_attempt = generate.call_args.args[-1]
        self.assertEqual(used_attempt["request_id"], "existing-request-id")
        saved = app_module._ecommerce_batch_snapshot(batch_id)
        saved_task = saved["tasks"][0]
        self.assertEqual(saved_task["state"], "accepted")
        self.assertEqual(len(saved_task["attempts"]), 1)

    def test_qc_service_failure_keeps_candidate_for_resume(self):
        garment_folder = self.make_garment("质检断点款")
        candidate = os.path.join(self.user_temp.name, "qc-candidate.jpg")
        self.make_image(candidate)
        batch_id = "ecbatch_qc_resume"
        task_id = "ectask_qc_resume"
        batch = {
            "id": batch_id, "status": "running", "output_path": self.user_temp.name,
            "settings": {"max_attempts": 3, "qc_enabled": True},
            "garments": [{"id": "g1", "name": "质检断点款", "path": garment_folder, "images": [os.path.join(garment_folder, f"{i}-参考.jpg") for i in range(1, 7)]}],
            "template": {"actions": [{"id": "a1", "name": "动作1", "order": 0, "action_image": candidate, "prompt": "测试", "platform": "oaihk"}]},
            "tasks": [{"id": task_id, "garment_id": "g1", "garment_name": "质检断点款", "action_id": "a1", "action_order": 0, "action_name": "动作1", "state": "pending", "attempts": [], "accepted_path": "", "manual_review_path": "", "last_error": ""}],
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})
        with patch.object(app_module, "_ecommerce_generate_candidate", return_value=candidate), \
             patch.object(app_module, "_ecommerce_qc_candidate", side_effect=RuntimeError("HK 503")), \
             patch.object(app_module.time, "sleep"):
            app_module._ecommerce_run_task(batch_id, task_id)
        saved_task = app_module._ecommerce_batch_snapshot(batch_id)["tasks"][0]
        self.assertEqual(saved_task["state"], "qc")
        self.assertEqual(len(saved_task["attempts"]), 1)
        self.assertEqual(saved_task["attempts"][0]["candidate_path"], candidate)
        self.assertIn("HK 503", saved_task["last_error"])

    def test_transport_failure_does_not_consume_candidate_quota(self):
        garment_folder = self.make_garment("网络断点款")
        candidate = os.path.join(self.user_temp.name, "network-candidate.jpg")
        self.make_image(candidate)
        batch_id = "ecbatch_transport_resume"
        task_id = "ectask_transport_resume"
        batch = {
            "id": batch_id, "status": "running", "output_path": self.user_temp.name, "result_folder_name": "AI换装结果-网络测试",
            "settings": {"max_attempts": 3, "qc_enabled": True},
            "garments": [{"id": "g1", "name": "网络断点款", "path": garment_folder, "images": [os.path.join(garment_folder, f"{i}-参考.jpg") for i in range(1, 7)]}],
            "template": {"actions": [{"id": "a1", "name": "动作1", "order": 0, "action_image": candidate, "prompt": "测试", "platform": "oaihk"}]},
            "tasks": [{"id": task_id, "garment_id": "g1", "garment_name": "网络断点款", "action_id": "a1", "action_order": 0, "action_name": "动作1", "state": "pending", "attempts": [], "accepted_path": "", "manual_review_path": "", "last_error": ""}],
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})
        with patch.object(app_module, "_ecommerce_generate_candidate", side_effect=RuntimeError("timeout")), \
             patch.object(app_module.time, "sleep"):
            app_module._ecommerce_run_task(batch_id, task_id)
        failed = app_module._ecommerce_batch_snapshot(batch_id)["tasks"][0]
        self.assertEqual(failed["state"], "preparing")
        self.assertEqual(len(failed["attempts"]), 1)
        self.assertFalse(failed["attempts"][0]["candidate_path"])

        with patch.object(app_module, "_ecommerce_generate_candidate", return_value=candidate), \
             patch.object(app_module, "_ecommerce_qc_candidate", return_value={"passed": True, "overall_score": 96, "critical_errors": []}):
            app_module._ecommerce_run_task(batch_id, task_id)
        resumed = app_module._ecommerce_batch_snapshot(batch_id)["tasks"][0]
        self.assertEqual(resumed["state"], "accepted")
        self.assertEqual(len(resumed["attempts"]), 1)

    def test_results_without_explicit_result_dir_never_contaminate_garment_references(self):
        garment_folder = self.make_garment("参考图隔离款")
        cache_folder = os.path.join(self.user_temp.name, "运行缓存")
        candidate = os.path.join(self.user_temp.name, "result.jpg")
        self.make_image(candidate)
        batch = {
            "id": "ecbatch_archive", "name": "测试批次", "result_folder_name": "AI换装结果-测试批次",
            "output_path": cache_folder,
            "garments": [{"id": "g1", "name": "参考图隔离款", "path": garment_folder, "images": []}],
            "tasks": [],
        }
        accepted_task = {"id": "t1", "garment_id": "g1", "garment_name": "参考图隔离款", "action_order": 0, "action_name": "正面", "state": "accepted", "attempts": []}
        manual_task = {"id": "t2", "garment_id": "g1", "garment_name": "参考图隔离款", "action_order": 1, "action_name": "侧面", "state": "manual_review", "attempts": [{"number": 1, "candidate_path": candidate, "qc": {"passed": False}}]}
        batch["tasks"] = [accepted_task, manual_task]
        accepted_path = app_module._ecommerce_archive_accepted(batch, accepted_task, candidate)
        mismatch_path = app_module._ecommerce_archive_mismatch(batch, manual_task, {"number": 1, "candidate_path": candidate})
        manual_task["accepted_path"] = ""
        manual_task["manual_review_path"] = app_module._ecommerce_archive_manual_review(batch, manual_task)
        accepted_task["accepted_path"] = accepted_path
        accepted_task["manual_review_path"] = ""
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})
        app_module._ecommerce_finalize_garment_outputs(batch["id"], "g1")
        result_root = os.path.join(cache_folder, "_生成样本备份", "参考图隔离款")
        self.assertTrue(accepted_path.startswith(result_root + os.sep))
        self.assertIn(os.path.join(result_root, "不匹配"), mismatch_path)
        self.assertTrue(os.path.isdir(os.path.join(result_root, "有1张需要人工补齐")))
        self.assertTrue(os.path.isfile(os.path.join(result_root, "批次质检记录.json")))
        self.assertFalse(any(name.startswith("AI-") for name in os.listdir(garment_folder)))

    def test_successful_sample_falls_back_to_app_cache_when_garment_folder_is_not_writable(self):
        garment_folder = self.make_garment("外置盘只读款")
        cache_folder = os.path.join(self.user_temp.name, "可写缓存")
        os.makedirs(cache_folder)
        candidate = os.path.join(self.user_temp.name, "paid-success.jpg")
        self.make_image(candidate)
        batch = {
            "id": "ecbatch_archive_fallback", "name": "归档回退测试", "status": "running",
            "output_path": cache_folder,
            "settings": {},
            "garments": [{"id": "g1", "name": "外置盘只读款", "path": garment_folder, "images": []}],
            "tasks": [],
        }
        task = {"id": "t1", "garment_id": "g1", "garment_name": "外置盘只读款", "action_order": 0, "action_name": "目标图1", "attempts": []}
        batch["tasks"] = [task]
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})
        real_copy = app_module._ecommerce_unique_copy

        def deny_only_garment_write(source, target):
            if target.startswith(garment_folder + os.sep):
                raise PermissionError("Operation not permitted")
            return real_copy(source, target)

        with patch.object(app_module, "_ecommerce_unique_copy", side_effect=deny_only_garment_write):
            archived = app_module._ecommerce_archive_sample(batch, task, candidate, 1, 1)

        self.assertTrue(os.path.isfile(archived))
        self.assertTrue(archived.startswith(os.path.join(cache_folder, "_生成样本备份") + os.sep))
        saved = app_module._ecommerce_batch_snapshot(batch["id"])
        self.assertTrue(saved["settings"]["archive_fallback"])
        self.assertEqual(saved["settings"]["archive_fallback_garments"]["外置盘只读款"], os.path.dirname(archived))

    def test_rerun_archive_name_uses_actual_override_model_code(self):
        garment_folder = self.make_garment("换模型重做款")
        result_root = os.path.join(self.user_temp.name, "results")
        candidate = os.path.join(self.user_temp.name, "rerun.jpg")
        self.make_image(candidate)
        batch = {
            "id": "rerun-code", "name": "重做模型命名", "output_path": self.user_temp.name,
            "run_code": "RH-NB2-LC-4K-R01",
            "garments": [{"id": "g1", "name": "换模型重做款", "path": garment_folder, "images": []}],
            "result_dirs": {"g1": result_root}, "settings": {}, "tasks": [],
        }
        task = {"id": "t1", "garment_id": "g1", "action_order": 0, "action_name": "目标图1", "attempts": []}
        archived = app_module._ecommerce_archive_sample(
            batch, task, candidate, 1, 1, run_code_override="RH-NBP-LC-4K-RR"
        )
        self.assertEqual(os.path.basename(archived), "RH-NBP-LC-4K-RR-AI-01.jpg")

    def test_deleted_sample_can_be_scanned_and_rerun_repeatedly(self):
        result_dir = os.path.join(self.user_temp.name, "repeat-rerun-results")
        os.makedirs(result_dir, exist_ok=True)
        original = os.path.join(result_dir, "RH-NB2-LC-4K-R01-AI-01.jpg")
        self.make_image(original)
        self.assertEqual(app_module._ecommerce_scan_missing_samples(result_dir, 1), [])

        os.remove(original)
        self.assertEqual(app_module._ecommerce_scan_missing_samples(result_dir, 1), [1])

        rerun = os.path.join(result_dir, "RH-GPT2-LC-4K-RR-AI-01.png")
        self.make_image(rerun)
        self.assertEqual(app_module._ecommerce_scan_missing_samples(result_dir, 1), [])

        os.remove(rerun)
        self.assertEqual(app_module._ecommerce_scan_missing_samples(result_dir, 1), [1])

    def test_runninghub_g2_low_cost_is_named_gpt2(self):
        action = {
            "platform": "runninghub",
            "model_key": "rhart-image-g-2/image-to-image-4k",
            "model_id": "rhart-image-g-2/image-to-image",
            "resolution": "4k",
            "channel": "low-cost",
        }
        self.assertEqual(app_module._ecommerce_run_code_parts(action), ("RH", "GPT2", "LC", "4K"))

    def test_rerun_rejects_a_result_path_that_points_at_garment_references(self):
        garment_folder = self.make_garment("禁止写入参考图")
        cache_folder = os.path.join(self.user_temp.name, "运行缓存")
        batch = {
            "id": "rerun-path-guard", "name": "路径保护", "output_path": cache_folder,
            "result_dirs": {}, "settings": {},
            "garments": [{"id": "g1", "name": "禁止写入参考图", "path": garment_folder, "images": []}],
            "template": {"actions": [{"id": "a1", "order": 0, "prompt": "测试"}]},
            "tasks": [{"id": "t1", "garment_id": "g1", "action_order": 0, "attempts": []}],
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})
        with patch.object(app_module, "_ecommerce_generate_candidate") as generate:
            response = self.client.post("/api/ecommerce/regenerate", json={
                "batch_id": batch["id"], "item_id": "g1-1", "result_path": garment_folder,
            })
        self.assertEqual(response.status_code, 409)
        self.assertIn("原AI结果目录不一致", response.get_json()["error"])
        generate.assert_not_called()

    def test_legacy_rerun_repair_moves_output_out_of_garment_folder(self):
        garment_folder = self.make_garment("旧批次款")
        cache_folder = os.path.join(self.user_temp.name, "运行缓存")
        result_dir = os.path.join(cache_folder, "_生成样本备份", "旧批次款")
        os.makedirs(result_dir, exist_ok=True)
        wrong_name = "RH-RHARTIMAGE-LC-4K-RR-AI-03.jpg"
        wrong_garment_path = os.path.join(garment_folder, wrong_name)
        wrong_backup_path = os.path.join(result_dir, wrong_name)
        self.make_image(wrong_garment_path)
        self.make_image(wrong_backup_path)
        signature = {
            "platform": "runninghub", "model_key": "rhart-image-g-2/image-to-image-4k",
            "model_id": "rhart-image-g-2/image-to-image", "resolution": "4K",
            "channel": "low-cost", "run_code": "RH-RHARTIMAGE-LC-4K-RR",
        }
        batch = {
            "id": "legacy-rerun", "name": "旧重做批次", "output_path": cache_folder,
            "result_dirs": {},
            "settings": {"archive_fallback_garments": {"旧批次款": result_dir}},
            "garments": [{"id": "g1", "name": "旧批次款", "path": garment_folder, "images": []}],
            "tasks": [{
                "id": "t1", "garment_id": "g1", "action_order": 2,
                "result_model": dict(signature),
                "attempts": [{"number": 99, "rerun": True, "archived_path": wrong_garment_path, "model_signature": dict(signature)}],
            }],
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})
        report = app_module._ecommerce_repair_legacy_rerun_archives(batch["id"])
        expected = os.path.join(result_dir, "RH-GPT2-LC-4K-RR-AI-03.jpg")
        self.assertEqual(report["repaired"], 1)
        self.assertTrue(os.path.isfile(expected))
        self.assertFalse(os.path.exists(wrong_garment_path))
        self.assertFalse(os.path.exists(wrong_backup_path))
        saved = app_module._ecommerce_batch_snapshot(batch["id"])
        self.assertEqual(saved["tasks"][0]["attempts"][0]["archived_path"], expected)
        self.assertEqual(app_module._ecommerce_repair_legacy_rerun_archives(batch["id"])["repaired"], 0)

    def test_garment_compare_uses_final_outputs_and_deleted_previews(self):
        garment_folder = self.make_garment("对比款", count=2)
        final_dir = os.path.join(self.user_temp.name, "final", "对比款", "RH-NB2-LC-4K-R01")
        os.makedirs(final_dir, exist_ok=True)
        final_image = os.path.join(final_dir, "RH-NB2-LC-4K-R01-AI-01.jpg")
        self.make_image(final_image)
        batch = {
            "id": "compare-batch", "name": "验片对比", "output_path": self.user_temp.name,
            "result_dirs": {"g1": final_dir}, "settings": {},
            "garments": [{
                "id": "g1", "name": "对比款", "path": garment_folder,
                "images": [os.path.join(garment_folder, "1-参考.jpg"), os.path.join(garment_folder, "2-参考.jpg")],
            }],
            "tasks": [
                {"id": "t1", "garment_id": "g1", "garment_name": "对比款", "action_order": 0, "action_name": "正面", "accepted_path": final_image, "attempts": []},
                {"id": "t2", "garment_id": "g1", "garment_name": "对比款", "action_order": 1, "action_name": "侧面", "accepted_path": os.path.join(final_dir, "已删除.jpg"), "attempts": []},
            ],
        }
        deleted_preview = app_module._ecommerce_task_preview_path(batch, batch["tasks"][1])
        os.makedirs(os.path.dirname(deleted_preview), exist_ok=True)
        self.make_image(deleted_preview, color=(160, 80, 90))
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})

        response = self.client.get("/api/ecommerce/batches/compare-batch/garments/g1/compare")
        self.assertEqual(response.status_code, 200, response.get_json())
        payload = response.get_json()
        self.assertEqual(len(payload["references"]), 2)
        self.assertEqual(len(payload["results"]), 2)
        self.assertFalse(payload["results"][0]["deleted"])
        self.assertEqual(payload["results"][0]["source"], "final_output")
        self.assertTrue(payload["results"][1]["deleted"])
        self.assertEqual(payload["results"][1]["source"], "deleted_preview")

    def test_target_only_compare_and_deleted_scan_use_original_target(self):
        target = os.path.join(self.user_temp.name, 'compare-target.jpg')
        self.make_image(target)
        result_dir = os.path.join(self.user_temp.name, 'target-only-results')
        os.makedirs(result_dir, exist_ok=True)
        generated = os.path.join(result_dir, 'RH-NB2-LC-2K-R01-AI-01.jpg')
        self.make_image(generated, color=(170, 90, 80))
        batch = {
            'id': 'target-only-compare', 'name': '单图对比', 'generation_mode': 'target_only',
            'output_path': self.user_temp.name, 'result_dirs': {'g1': result_dir},
            'settings': {'generation_mode': 'target_only', 'samples_per_action': 1, 'qc_enabled': False},
            'template': {'actions': [{
                'id': 'a1', 'order': 0, 'name': '目标图1', 'action_image': target,
                'prompt': '测试提示词', 'platform': 'runninghub', 'model_key': 'nano/2k',
            }]},
            'garments': [{'id': 'g1', 'name': '单图提示词', 'path': '', 'images': [], 'virtual': True}],
            'tasks': [{
                'id': 't1', 'garment_id': 'g1', 'garment_name': '单图提示词',
                'action_id': 'a1', 'action_order': 0, 'action_name': '目标图1',
                'state': 'accepted', 'accepted_path': generated, 'attempts': [],
            }],
            'usage': {},
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {'version': 2, 'templates': [], 'batches': [batch], 'waste_scans': []})
        response = self.client.get('/api/ecommerce/batches/target-only-compare/garments/g1/compare')
        self.assertEqual(response.status_code, 200, response.get_json())
        compare = response.get_json()
        self.assertEqual(compare['generation_mode'], 'target_only')
        self.assertEqual(len(compare['references']), 1)
        self.assertEqual(compare['references'][0]['path'], target)
        self.assertEqual(compare['references'][0]['role'], 'target')

        os.remove(generated)
        scan = self.client.post('/api/ecommerce/scan-deleted', json={'batch_id': batch['id']})
        self.assertEqual(scan.status_code, 200, scan.get_json())
        item = scan.get_json()['items'][0]
        self.assertEqual(item['generation_mode'], 'target_only')
        self.assertEqual(len(item['references']), 1)
        self.assertEqual(item['references'][0]['path'], target)

    def test_deleted_scan_detects_partially_missing_multi_sample_action(self):
        target = os.path.join(self.user_temp.name, 'partial-target.jpg')
        reference = os.path.join(self.user_temp.name, 'partial-reference.jpg')
        result_dir = os.path.join(self.user_temp.name, 'partial-results')
        os.makedirs(result_dir)
        self.make_image(target)
        self.make_image(reference)
        # The uniquified suffix mirrors a real second rerun filename. It must
        # still count as action 01 instead of disappearing from the scanner.
        self.make_image(os.path.join(result_dir, 'RUN-AI-01-1.jpg'))
        self.make_image(os.path.join(result_dir, 'RUN-AI-01-2-2.jpg'))
        batch = {
            'id': 'partial-sample-scan', 'name': '部分删除扫描',
            'output_path': self.user_temp.name, 'result_dirs': {'g1': result_dir},
            'settings': {'samples_per_action': 3, 'qc_enabled': False},
            'template': {'actions': [{
                'id': 'a1', 'order': 0, 'name': '正面', 'action_image': target,
                'prompt': '测试', 'platform': 'runninghub', 'model_key': 'nano/2k',
            }]},
            'garments': [{'id': 'g1', 'name': '款式1', 'path': self.user_temp.name, 'images': [reference]}],
            'tasks': [{
                'id': 't1', 'garment_id': 'g1', 'garment_name': '款式1',
                'action_id': 'a1', 'action_order': 0, 'action_name': '正面',
                'state': 'accepted', 'attempts': [],
            }],
            'usage': {},
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {
            'version': 2, 'templates': [], 'batches': [batch], 'waste_scans': [],
        })

        response = self.client.post('/api/ecommerce/scan-deleted', json={'batch_id': batch['id']})
        self.assertEqual(response.status_code, 200, response.get_json())
        items = response.get_json()['items']
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['action_order'], 1)
        self.assertEqual(items[0]['actual_count'], 2)
        self.assertEqual(items[0]['expected_count'], 3)
        self.assertEqual(items[0]['missing_count'], 1)

    def test_deleted_scan_ledger_survives_another_model_result_and_repeated_refresh(self):
        target = os.path.join(self.user_temp.name, 'ledger-target.jpg')
        reference = os.path.join(self.user_temp.name, 'ledger-reference.jpg')
        result_dir = os.path.join(self.user_temp.name, 'ledger-results')
        os.makedirs(result_dir)
        self.make_image(target)
        self.make_image(reference)
        deleted_output = os.path.join(result_dir, 'RH-NB2-LC-2K-R01-AI-01.jpg')
        remaining_output = os.path.join(result_dir, 'HK-GPT2-OFF-4K-R02-AI-01.jpg')
        self.make_image(deleted_output, color=(150, 70, 60))
        self.make_image(remaining_output, color=(60, 100, 150))
        batch = {
            'id': 'deletion-ledger-scan', 'name': '多模型删除扫描',
            'output_path': self.user_temp.name, 'result_dirs': {'g1': result_dir},
            'settings': {'samples_per_action': 1, 'qc_enabled': False},
            'template': {'actions': [{
                'id': 'a1', 'order': 0, 'name': '正面', 'action_image': target,
                'prompt': '测试', 'platform': 'runninghub', 'model_key': 'nano/2k',
            }]},
            'garments': [{'id': 'g1', 'name': '款式1', 'path': self.user_temp.name, 'images': [reference]}],
            'tasks': [{
                'id': 't1', 'garment_id': 'g1', 'garment_name': '款式1',
                'action_id': 'a1', 'action_order': 0, 'action_name': '正面',
                'state': 'accepted', 'accepted_path': deleted_output, 'attempts': [],
            }],
            'usage': {},
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {
            'version': 2, 'templates': [], 'batches': [batch], 'waste_scans': [],
        })

        deleted = self.client.post('/api/ecommerce/delete-sample', json={
            'batch_id': batch['id'], 'garment_id': 'g1', 'path': deleted_output,
        })
        self.assertEqual(deleted.status_code, 200, deleted.get_json())
        self.assertTrue(os.path.isfile(deleted_output + '.deleted'))

        for _ in range(2):
            scan = self.client.post('/api/ecommerce/scan-deleted', json={'batch_id': batch['id']})
            self.assertEqual(scan.status_code, 200, scan.get_json())
            items = scan.get_json()['items']
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]['actual_count'], 1)
            self.assertEqual(items[0]['deleted_record_count'], 1)
            self.assertEqual(items[0]['missing_count'], 1)
            self.assertTrue(os.path.isfile(items[0]['bad_photo_path']))

        stored = app_module._ecommerce_batch_snapshot(batch['id'])
        self.assertEqual(len(stored.get('deleted_samples') or []), 1)
        undo = self.client.post('/api/ecommerce/undo-delete', json={
            'batch_id': batch['id'], 'garment_id': 'g1', 'path': deleted_output,
        })
        self.assertEqual(undo.status_code, 200, undo.get_json())
        scan = self.client.post('/api/ecommerce/scan-deleted', json={'batch_id': batch['id']})
        self.assertEqual(scan.status_code, 200, scan.get_json())
        self.assertEqual(scan.get_json()['items'], [])

    def test_deleted_scan_backfills_pre_ledger_deletion_from_archive_history(self):
        target = os.path.join(self.user_temp.name, 'history-target.jpg')
        reference = os.path.join(self.user_temp.name, 'history-reference.jpg')
        result_dir = os.path.join(self.user_temp.name, 'history-results')
        os.makedirs(result_dir)
        self.make_image(target)
        self.make_image(reference)
        old_output = os.path.join(result_dir, 'RH-GPT2-LC-4K-R06-AI-01.png')
        remaining_output = os.path.join(result_dir, 'RH-NB2-LC-4K-R07-AI-01.jpg')
        self.make_image(remaining_output)
        batch = {
            'id': 'history-backfill-scan', 'name': '旧版删除回填',
            'output_path': self.user_temp.name, 'result_dirs': {'g1': result_dir},
            'settings': {'samples_per_action': 1, 'qc_enabled': False},
            'template': {'actions': [{
                'id': 'a1', 'order': 0, 'name': '正面', 'action_image': target,
                'prompt': '测试', 'platform': 'runninghub', 'model_key': 'gpt/4k',
            }]},
            'garments': [{'id': 'g1', 'name': '款式1', 'path': self.user_temp.name, 'images': [reference]}],
            'tasks': [{
                'id': 't1', 'garment_id': 'g1', 'garment_name': '款式1',
                'action_id': 'a1', 'action_order': 0, 'action_name': '正面',
                'state': 'accepted', 'accepted_path': old_output,
                'attempts': [{'archived_path': old_output}],
            }],
            'usage': {},
        }
        preview = app_module._ecommerce_task_preview_path(batch, batch['tasks'][0])
        os.makedirs(os.path.dirname(preview), exist_ok=True)
        self.make_image(preview, color=(170, 90, 70))
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {
            'version': 2, 'templates': [], 'batches': [batch], 'waste_scans': [],
        })

        for _ in range(2):
            scan = self.client.post('/api/ecommerce/scan-deleted', json={'batch_id': batch['id']})
            self.assertEqual(scan.status_code, 200, scan.get_json())
            items = scan.get_json()['items']
            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]['actual_count'], 1)
            self.assertEqual(items[0]['deleted_record_count'], 1)
            self.assertEqual(items[0]['bad_photo_path'], preview)
        stored = app_module._ecommerce_batch_snapshot(batch['id'])
        self.assertEqual(len(stored.get('deleted_samples') or []), 1)
        self.assertEqual(stored['deleted_samples'][0]['original_path'], old_output)

    def test_refresh_returns_exact_union_of_deleted_and_marked_images(self):
        target = os.path.join(self.user_temp.name, 'union-target.jpg')
        reference = os.path.join(self.user_temp.name, 'union-reference.jpg')
        candidate = os.path.join(self.user_temp.name, 'union-candidate.jpg')
        result_dir = os.path.join(self.user_temp.name, 'union-results')
        os.makedirs(result_dir)
        for path in (target, reference, candidate):
            self.make_image(path)
        outputs = [
            os.path.join(result_dir, 'RH-GPT2-LC-4K-R01-AI-01.jpg'),
            os.path.join(result_dir, 'RH-NB2-LC-4K-R02-AI-01.jpg'),
            os.path.join(result_dir, 'HK-GPT2-OFF-4K-R03-AI-01.jpg'),
        ]
        for index, path in enumerate(outputs):
            self.make_image(path, color=(80 + index * 20, 90, 100))
        action = {
            'id': 'a1', 'order': 0, 'name': '正面', 'action_image': target,
            'prompt': '测试', 'platform': 'runninghub',
            'model_key': 'rhart-image-n-g31-flash/image-to-image-2k',
            'endpoint': 'rhart-image-n-g31-flash/image-to-image', 'resolution': '2k',
        }
        batch = {
            'id': 'deleted-marked-union', 'name': '删除与标记并集', 'run_code': 'RUN',
            'output_path': self.user_temp.name, 'result_dirs': {'g1': result_dir},
            'settings': {'samples_per_action': 1, 'qc_enabled': False},
            'template': {'actions': [action]},
            'garments': [{'id': 'g1', 'name': '款式1', 'path': self.user_temp.name, 'images': [reference]}],
            'tasks': [{
                'id': 't1', 'garment_id': 'g1', 'garment_name': '款式1',
                'action_id': 'a1', 'action_order': 0, 'action_name': '正面',
                'state': 'accepted', 'accepted_path': outputs[0],
                'attempts': [{'archived_path': outputs[0]}],
            }],
            'usage': {},
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {
            'version': 2, 'templates': [], 'batches': [batch], 'waste_scans': [],
        })

        mark_ids = []
        for path in outputs[:2]:
            response = self.client.post('/api/ecommerce/mark-redo', json={
                'batch_id': batch['id'], 'garment_id': 'g1', 'action_order': 1, 'result_path': path,
            })
            self.assertEqual(response.status_code, 200, response.get_json())
            mark_ids.append(response.get_json()['mark_id'])
        duplicate = self.client.post('/api/ecommerce/mark-redo', json={
            'batch_id': batch['id'], 'garment_id': 'g1', 'action_order': 1, 'result_path': outputs[0],
        })
        self.assertEqual(duplicate.get_json()['mark_id'], mark_ids[0])
        compare = self.client.get('/api/ecommerce/batches/deleted-marked-union/garments/g1/compare').get_json()
        self.assertEqual(
            {row['path'] for row in compare['results'] if row.get('marked_redo')},
            set(outputs[:2]),
        )

        deleted = self.client.post('/api/ecommerce/delete-sample', json={
            'batch_id': batch['id'], 'garment_id': 'g1', 'path': outputs[0],
        })
        self.assertEqual(deleted.status_code, 200, deleted.get_json())
        for _ in range(2):
            scan = self.client.post('/api/ecommerce/scan-deleted', json={'batch_id': batch['id']})
            self.assertEqual(scan.status_code, 200, scan.get_json())
            items = scan.get_json()['items']
            self.assertEqual(len(items), 2)
            waste = next(item for item in items if not item.get('marked_redo'))
            marked = next(item for item in items if item.get('marked_redo'))
            self.assertTrue(waste['also_marked_redo'])
            self.assertIn(mark_ids[0], waste['merged_mark_ids'])
            self.assertEqual(marked['mark_id'], mark_ids[1])
            self.assertEqual(marked['bad_photo_path'], outputs[1])

        with patch.object(app_module, '_ecommerce_generate_candidate', return_value=candidate):
            rerun = self.client.post('/api/ecommerce/regenerate', json={
                'batch_id': batch['id'], 'item_id': 'g1-1', 'result_path': result_dir,
                'reference_images': [reference], 'prompt': '', 'count': 1,
            })
        self.assertEqual(rerun.status_code, 200, rerun.get_json())
        scan = self.client.post('/api/ecommerce/scan-deleted', json={'batch_id': batch['id']})
        self.assertEqual(scan.status_code, 200, scan.get_json())
        self.assertEqual(len(scan.get_json()['items']), 1)
        self.assertEqual(scan.get_json()['items'][0]['mark_id'], mark_ids[1])

        unmark = self.client.post('/api/ecommerce/unmark-redo', json={
            'batch_id': batch['id'], 'garment_id': 'g1', 'action_order': 1,
            'mark_id': mark_ids[1], 'result_path': outputs[1],
        })
        self.assertEqual(unmark.status_code, 200, unmark.get_json())
        scan = self.client.post('/api/ecommerce/scan-deleted', json={'batch_id': batch['id']})
        self.assertEqual(scan.status_code, 200, scan.get_json())
        self.assertEqual(scan.get_json()['items'], [])

    def test_target_only_rerun_accepts_empty_reference_list_and_keeps_garment_images_empty(self):
        target = os.path.join(self.user_temp.name, 'rerun-target.jpg')
        candidate = os.path.join(self.user_temp.name, 'rerun-candidate.jpg')
        self.make_image(target)
        self.make_image(candidate, color=(190, 100, 60))
        result_dir = os.path.join(self.user_temp.name, 'target-only-rerun-results')
        os.makedirs(result_dir, exist_ok=True)
        batch = {
            'id': 'target-only-rerun', 'name': '单图重做', 'generation_mode': 'target_only',
            'output_path': self.user_temp.name, 'result_dirs': {'g1': result_dir}, 'run_code': 'RH-NB2-LC-2K-R01',
            'settings': {'generation_mode': 'target_only', 'samples_per_action': 1, 'qc_enabled': False},
            'template': {'actions': [{
                'id': 'a1', 'order': 0, 'name': '目标图1', 'action_image': target, 'prompt': '原提示词',
                'platform': 'runninghub', 'model_key': 'rhart-image-n-g31-flash/image-to-image-2k',
                'endpoint': 'rhart-image-n-g31-flash/image-to-image', 'resolution': '2k',
            }]},
            'garments': [{'id': 'g1', 'name': '单图提示词', 'path': '', 'images': [], 'virtual': True}],
            'tasks': [{
                'id': 't1', 'garment_id': 'g1', 'garment_name': '单图提示词',
                'action_id': 'a1', 'action_order': 0, 'action_name': '目标图1', 'state': 'accepted', 'attempts': [],
            }],
            'usage': {},
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {'version': 2, 'templates': [], 'batches': [batch], 'waste_scans': []})
        captured = {}

        def fake_generate(_batch, _task, garment, action, prompt, _attempt):
            captured['images'] = list(garment.get('images') or [])
            captured['action_image'] = action.get('action_image')
            captured['prompt'] = prompt
            return candidate

        with patch.object(app_module, '_ecommerce_generate_candidate', side_effect=fake_generate):
            response = self.client.post('/api/ecommerce/regenerate', json={
                'batch_id': batch['id'], 'item_id': 'g1-1', 'result_path': result_dir,
                'reference_images': [], 'prompt': '', 'count': 1,
            })
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual(captured['images'], [])
        self.assertEqual(captured['action_image'], target)
        self.assertEqual(captured['prompt'], '原提示词')

    def test_garment_prompt_compare_scan_and_rerun_stay_bound_to_the_same_subfolder(self):
        folder_one = os.path.join(self.user_temp.name, '来源', '第一组')
        folder_two = os.path.join(self.user_temp.name, '来源', '第二组')
        result_one = os.path.join(self.user_temp.name, '成品', '来源', '第一组', 'RUN')
        result_two = os.path.join(self.user_temp.name, '成品', '来源', '第二组', 'RUN')
        for folder in (folder_one, folder_two, result_one, result_two):
            os.makedirs(folder, exist_ok=True)
        source_one = os.path.join(folder_one, '同序号.jpg')
        source_two = os.path.join(folder_two, '同序号.jpg')
        generated_one = os.path.join(result_one, 'RUN-AI-01.jpg')
        generated_two = os.path.join(result_two, 'RUN-AI-01.jpg')
        candidate = os.path.join(self.user_temp.name, 'rerun-second.jpg')
        self.make_image(source_one, color=(20, 40, 60))
        self.make_image(source_two, color=(80, 100, 120))
        self.make_image(generated_one, color=(120, 80, 60))
        self.make_image(generated_two, color=(150, 90, 70))
        self.make_image(candidate, color=(180, 110, 80))
        common = {
            'prompt': '统一提示词', 'platform': 'runninghub',
            'model_key': 'rhart-image-n-g31-flash/image-to-image-2k',
            'endpoint': 'rhart-image-n-g31-flash/image-to-image', 'resolution': '2k',
        }
        batch = {
            'id': 'prompt-binding', 'name': '递归绑定', 'generation_mode': 'garment_prompt',
            'output_path': self.user_temp.name, 'run_code': 'RUN',
            'result_dirs': {'g1': result_one, 'g2': result_two},
            'settings': {'generation_mode': 'garment_prompt', 'samples_per_action': 1, 'qc_enabled': False},
            'template': {'actions': [
                {'id': 'a1', 'garment_id': 'g1', 'order': 0, 'name': '第一组原图', 'action_image': source_one, **common},
                {'id': 'a2', 'garment_id': 'g2', 'order': 0, 'name': '第二组原图', 'action_image': source_two, **common},
            ]},
            'garments': [
                {'id': 'g1', 'name': '第一组', 'path': folder_one, 'images': [source_one], 'prompt_image_group': True},
                {'id': 'g2', 'name': '第二组', 'path': folder_two, 'images': [source_two], 'prompt_image_group': True},
            ],
            'tasks': [
                {'id': 't1', 'garment_id': 'g1', 'garment_name': '第一组', 'action_id': 'a1', 'action_order': 0, 'action_name': '第一组原图', 'state': 'accepted', 'accepted_path': generated_one, 'attempts': []},
                {'id': 't2', 'garment_id': 'g2', 'garment_name': '第二组', 'action_id': 'a2', 'action_order': 0, 'action_name': '第二组原图', 'state': 'accepted', 'accepted_path': generated_two, 'attempts': []},
            ],
            'usage': {},
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {'version': 2, 'templates': [], 'batches': [batch], 'waste_scans': []})

        compare = self.client.get('/api/ecommerce/batches/prompt-binding/garments/g2/compare')
        self.assertEqual(compare.status_code, 200, compare.get_json())
        compare_data = compare.get_json()
        self.assertEqual(compare_data['generation_mode'], 'garment_prompt')
        self.assertEqual([ref['path'] for ref in compare_data['references']], [source_two])
        self.assertEqual(compare_data['references'][0]['role'], 'source_garment')

        os.remove(generated_two)
        scan = self.client.post('/api/ecommerce/scan-deleted', json={'batch_id': batch['id']})
        self.assertEqual(scan.status_code, 200, scan.get_json())
        items = scan.get_json()['items']
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['garment_id'], 'g2')
        self.assertEqual([ref['path'] for ref in items[0]['references']], [source_two])

        captured = {}
        def fake_generate(_batch, _task, garment, action, prompt, _attempt):
            captured['garment_id'] = garment['id']
            captured['garment_images'] = list(garment.get('images') or [])
            captured['action_image'] = action['action_image']
            captured['prompt'] = prompt
            return candidate

        with patch.object(app_module, '_ecommerce_generate_candidate', side_effect=fake_generate):
            rerun = self.client.post('/api/ecommerce/regenerate', json={
                'batch_id': batch['id'], 'item_id': 'g2-1', 'result_path': result_two,
                'reference_images': [], 'prompt': '', 'count': 1,
            })
        self.assertEqual(rerun.status_code, 200, rerun.get_json())
        self.assertEqual(captured['garment_id'], 'g2')
        self.assertEqual(captured['garment_images'], [])
        self.assertEqual(captured['action_image'], source_two)
        self.assertEqual(captured['prompt'], '统一提示词')

    def test_garment_prompt_recursive_batch_completes_and_archives_every_source(self):
        root = os.path.join(self.user_temp.name, '夜间批量')
        child = os.path.join(root, '子目录')
        os.makedirs(child)
        sources = [
            os.path.join(root, '01.jpg'),
            os.path.join(child, '02.jpg'),
            os.path.join(child, '03.jpg'),
        ]
        for index, path in enumerate(sources):
            self.make_image(path, color=(40 + index * 20, 80, 120))
        final_root = os.path.join(self.user_temp.name, '最终成品')
        response = self.client.post('/api/ecommerce/batches', json={
            'generation_mode': 'garment_prompt',
            'prompt_action': {
                'prompt': '共用提示词', 'platform': 'runninghub',
                'model_key': 'rhart-image-n-g31-flash/image-to-image-2k',
                'endpoint': 'rhart-image-n-g31-flash/image-to-image', 'resolution': '2k',
            },
            'clothing_root': root,
            'output_path': os.path.join(self.user_temp.name, '运行缓存'),
            'final_output_path': final_root,
            'concurrency': 3,
            'samples_per_action': 1,
            'qc_enabled': False,
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertIn('预计3次付费图生图调用', response.get_json()['warning'])
        batch_id = response.get_json()['batch']['id']
        candidate = os.path.join(self.user_temp.name, 'mock-result.jpg')
        self.make_image(candidate, color=(190, 130, 90))
        submitted_sources = []

        def fake_generate(_batch, _task, _garment, action, prompt, attempt):
            submitted_sources.append(action['action_image'])
            self.assertEqual(prompt, '共用提示词')
            attempt['status'] = 'downloaded'
            return candidate

        app_module._ecommerce_mutate_batch(batch_id, lambda batch: batch.update({'status': 'running'}))
        with patch.object(app_module, '_ecommerce_generate_candidate', side_effect=fake_generate):
            app_module._ecommerce_run_batch_no_qc_global(batch_id)

        finished = app_module._ecommerce_batch_snapshot(batch_id)
        self.assertEqual(finished['status'], 'completed')
        self.assertEqual(set(submitted_sources), set(map(os.path.realpath, sources)))
        self.assertEqual(len(finished['tasks']), 3)
        self.assertTrue(all(task['state'] == 'accepted' for task in finished['tasks']))
        self.assertTrue(all(os.path.isfile(task['accepted_path']) for task in finished['tasks']))
        for group in finished['garments']:
            self.assertTrue(os.path.isdir(finished['result_dirs'][group['id']]))

    def test_one_source_three_samples_run_concurrently_when_concurrency_is_three(self):
        source = os.path.join(self.user_temp.name, '单图三抽.jpg')
        self.make_image(source)
        response = self.client.post('/api/ecommerce/batches', json={
            'generation_mode': 'garment_prompt',
            'prompt_action': {
                'prompt': '同一张图生成三个候选', 'platform': 'runninghub',
                'model_key': 'rhart-image-n-g31-flash/image-to-image-2k',
                'endpoint': 'rhart-image-n-g31-flash/image-to-image', 'resolution': '2k',
            },
            'garment_images': [source],
            'garment_name': '并发测试',
            'output_path': os.path.join(self.user_temp.name, '并发缓存'),
            'final_output_path': os.path.join(self.user_temp.name, '并发成品'),
            'concurrency': 3,
            'samples_per_action': 3,
            'qc_enabled': False,
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        self.assertIn('每张生成3个候选，预计3次付费图生图调用', response.get_json()['warning'])
        batch_id = response.get_json()['batch']['id']
        candidates = {}
        for number in range(1, 4):
            path = os.path.join(self.user_temp.name, f'candidate-{number}.jpg')
            self.make_image(path, color=(50 * number, 80, 120))
            candidates[number] = path
        barrier = threading.Barrier(3)
        state = {'active': 0, 'max_active': 0}
        state_lock = threading.Lock()

        def fake_generate(_batch, _task, _garment, action, prompt, attempt):
            self.assertEqual(action['action_image'], os.path.realpath(source))
            self.assertEqual(prompt, '同一张图生成三个候选')
            with state_lock:
                state['active'] += 1
                state['max_active'] = max(state['max_active'], state['active'])
            try:
                barrier.wait(timeout=2)
                return candidates[int(attempt['number'])]
            finally:
                with state_lock:
                    state['active'] -= 1

        app_module._ecommerce_mutate_batch(batch_id, lambda batch: batch.update({'status': 'running'}))
        with patch.object(app_module, '_ecommerce_generate_candidate', side_effect=fake_generate):
            app_module._ecommerce_run_batch_no_qc_global(batch_id)

        finished = app_module._ecommerce_batch_snapshot(batch_id)
        task = finished['tasks'][0]
        self.assertEqual(finished['status'], 'completed')
        self.assertEqual(state['max_active'], 3)
        archived = sorted(
            attempt['archived_path'] for attempt in task['attempts'] if attempt.get('archived_path')
        )
        self.assertEqual(len(archived), 3)
        self.assertTrue(all(os.path.isfile(path) for path in archived))
        self.assertEqual(
            sorted(os.path.basename(path).rsplit('.', 1)[0].rsplit('-', 1)[-1] for path in archived),
            ['1', '2', '3'],
        )

    def test_model_signature_normalizes_resolution_for_waste_breakdown(self):
        lower = app_module._ecommerce_action_model_signature({
            'platform': 'runninghub', 'model_key': 'rhart-image-n-g31-flash/image-to-image-4k',
            'resolution': '4k', 'channel': 'low-cost',
        })
        upper = app_module._ecommerce_action_model_signature({
            'platform': 'runninghub', 'model_key': 'rhart-image-n-g31-flash/image-to-image-4k',
            'resolution': '4K', 'channel': 'LOW-COST',
        })
        self.assertEqual(lower['key'], upper['key'])

    def test_runninghub_billing_usage_is_recorded_once_across_resume_queries(self):
        attempt = {"number": 1, "request_id": "rh-paid-task", "status": "submitted"}
        batch = {
            "id": "ecbatch_billing_once", "usage": {"generation_requests": 1},
            "tasks": [{"id": "t1", "attempts": [dict(attempt)]}],
        }
        app_module.save_json(app_module.ECOMMERCE_DATA_FILE, {"version": 1, "templates": [], "batches": [batch]})
        response = {"usage": {"thirdPartyConsumeMoney": "0.3", "consumeMoney": None, "taskCostTime": "0"}}
        app_module._ecommerce_record_runninghub_usage(batch["id"], "t1", attempt, response)
        app_module._ecommerce_record_runninghub_usage(batch["id"], "t1", attempt, response)
        saved = app_module._ecommerce_batch_snapshot(batch["id"])
        self.assertEqual(saved["usage"]["runninghub_billed_cny"], 0.3)
        self.assertEqual(saved["tasks"][0]["attempts"][0]["billed_cny"], 0.3)

    def test_scheduler_finishes_one_garment_wave_before_next(self):
        self.make_garment("波次A")
        self.make_garment("波次B")
        action_image = os.path.join(self.user_temp.name, "wave-action.jpg")
        self.make_image(action_image)
        actions = [{"name": f"动作{i}", "action_image": action_image, "prompt": "测试", "platform": "oaihk", "model_key": "fal-ai/banana/v3.1/flash/2k"} for i in range(1, 4)]
        template_id = self.client.post("/api/ecommerce/templates", json={"name": "三动作", "actions": actions}).get_json()["template"]["id"]
        batch = self.client.post("/api/ecommerce/batches", json={"template_id": template_id, "clothing_root": self.user_temp.name, "output_path": self.user_temp.name, "concurrency": 20}).get_json()["batch"]
        app_module._ecommerce_mutate_batch(batch["id"], lambda b: b.update({"status": "running"}))
        events = []
        starts_lock = threading.Lock()

        def fake_generate(batch_id, task_id, number):
            snapshot = app_module._ecommerce_batch_snapshot(batch_id)
            task = app_module._ecommerce_find_task(snapshot, task_id)
            with starts_lock:
                events.append(f"gen:{task['garment_name']}:{number}")
            attempt = {"number": number, "status": "awaiting_qc", "candidate_path": action_image, "qc": None}
            app_module._ecommerce_mutate_batch(batch_id, lambda b: (app_module._ecommerce_sync_attempt(b, task_id, attempt), app_module._ecommerce_set_task_state(b, task_id, "awaiting_qc")))
            return True

        def fake_qc(batch_id, task_id, number):
            snapshot = app_module._ecommerce_batch_snapshot(batch_id)
            task = app_module._ecommerce_find_task(snapshot, task_id)
            with starts_lock:
                events.append(f"qc:{task['garment_name']}:{number}")
            app_module._ecommerce_mutate_batch(batch_id, lambda b: app_module._ecommerce_accept_task(b, task_id, "fake.jpg"))
            return True

        with patch.object(app_module, "_ecommerce_generate_task_attempt", side_effect=fake_generate), \
             patch.object(app_module, "_ecommerce_qc_task_attempt", side_effect=fake_qc), \
             patch.object(app_module, "_ecommerce_finalize_garment_outputs"):
            app_module._ecommerce_run_batch(batch["id"])

        first_qc_a = min(i for i, event in enumerate(events) if event.startswith("qc:波次A"))
        last_gen_a = max(i for i, event in enumerate(events) if event.startswith("gen:波次A"))
        first_gen_b = min(i for i, event in enumerate(events) if event.startswith("gen:波次B"))
        last_qc_a = max(i for i, event in enumerate(events) if event.startswith("qc:波次A"))
        self.assertLess(last_gen_a, first_qc_a)
        self.assertLess(last_qc_a, first_gen_b)
        saved = app_module._ecommerce_batch_snapshot(batch["id"])
        self.assertEqual(saved["settings"]["concurrency"], 20)
        self.assertEqual(saved["status"], "completed")

    def test_round_scheduler_generates_all_then_qcs_and_only_retries_failures(self):
        self.make_garment("分轮款")
        action_image = os.path.join(self.user_temp.name, "round-action.jpg")
        self.make_image(action_image)
        actions = [{"name": f"动作{i}", "action_image": action_image, "prompt": "测试", "platform": "oaihk", "model_key": "fal-ai/banana/v3.1/flash/2k"} for i in range(1, 4)]
        template_id = self.client.post("/api/ecommerce/templates", json={"name": "分轮三动作", "actions": actions}).get_json()["template"]["id"]
        batch = self.client.post("/api/ecommerce/batches", json={"template_id": template_id, "clothing_root": self.user_temp.name, "output_path": self.user_temp.name, "concurrency": 3}).get_json()["batch"]
        app_module._ecommerce_mutate_batch(batch["id"], lambda b: b.update({"status": "running"}))
        events = []
        event_lock = threading.Lock()
        qc_counts = {}

        def fake_generate(batch, task, garment, action, prompt, attempt):
            with event_lock:
                events.append(("gen", attempt["number"], action["name"]))
            return action_image

        def fake_qc(batch, garment, action, candidate):
            with event_lock:
                qc_counts[action["name"]] = qc_counts.get(action["name"], 0) + 1
                round_number = qc_counts[action["name"]]
                events.append(("qc", round_number, action["name"]))
            passed = not (action["name"] == "动作2" and round_number == 1)
            return {"passed": passed, "overall_score": 96 if passed else 70, "critical_errors": [] if passed else ["盘扣不一致"], "correction_prompt": "修正盘扣"}

        with patch.object(app_module, "_ecommerce_generate_candidate", side_effect=fake_generate), \
             patch.object(app_module, "_ecommerce_qc_candidate", side_effect=fake_qc), \
             patch.object(app_module, "_ecommerce_candidate_output_spec", return_value={"passed": True, "errors": []}), \
             patch.object(app_module, "_ecommerce_archive_accepted", side_effect=lambda b, t, p: p), \
             patch.object(app_module, "_ecommerce_archive_mismatch", side_effect=lambda b, t, a: a.get("candidate_path", "")), \
             patch.object(app_module, "_ecommerce_finalize_garment_outputs"):
            app_module._ecommerce_run_batch(batch["id"])

        first_qc = min(i for i, event in enumerate(events) if event[0] == "qc")
        last_first_round_gen = max(i for i, event in enumerate(events) if event[0] == "gen" and event[1] == 1)
        self.assertLess(last_first_round_gen, first_qc)
        self.assertEqual(sorted(event[2] for event in events if event[0] == "gen" and event[1] == 1), ["动作1", "动作2", "动作3"])
        self.assertEqual([event[2] for event in events if event[0] == "gen" and event[1] == 2], ["动作2"])
        saved = app_module._ecommerce_batch_snapshot(batch["id"])
        self.assertEqual(saved["status"], "completed")
        self.assertTrue(all(task["state"] == "accepted" for task in saved["tasks"]))

    def test_image_generation_uses_platform_then_platform_specific_model(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn('id="cfg-api-platform"', html)
        self.assertIn('id="cfg-rh-model-inline"', html)
        self.assertIn('id="cfg-oaihk-model-inline"', html)
        self.assertIn('id="split-cfg-api-platform"', html)
        self.assertIn('id="ecommerce-import-platform"', html)
        self.assertIn('id="ecommerce-import-rh-model"', html)
        self.assertIn('id="ecommerce-import-oaihk-model"', html)
        self.assertIn('id="ecommerce-import-summary"', html)
        self.assertIn('id="ecommerce-import-preview"', html)
        self.assertIn('id="ecommerce-rh-api-switch"', html)
        self.assertIn('id="ecommerce-rh-api-key"', html)
        self.assertIn('id="ecommerce-rh-base-url"', html)
        self.assertIn('id="btn-ecommerce-save-rh-api"', html)
        self.assertIn('id="ecommerce-target-dropzone"', html)
        self.assertIn('id="ecommerce-target-files"', html)
        self.assertIn('multiple hidden', html)
        self.assertIn('id="btn-ecommerce-select-target-files"', html)
        self.assertIn('id="btn-ecommerce-select-actions"', html)
        self.assertIn('data-tip=', html)
        self.assertIn('服装参考图', html)
        self.assertIn('素材与模型', html)
        self.assertIn('将服装图或文件夹拖到这里', html)
        self.assertIn('id="ecommerce-garment-dropzone"', html)
        self.assertIn('id="ecommerce-garment-keyword"', html)
        self.assertIn('id="btn-ecommerce-create">生成', html)
        self.assertNotIn('id="ecommerce-template-select"', html)
        self.assertNotIn('id="btn-ecommerce-delete-template"', html)
        self.assertNotIn('id="btn-ecommerce-import-actions"', html)
        self.assertNotIn('id="btn-ecommerce-trial"', html)
        self.assertNotIn('保存目标替换参考图', html)
        self.assertNotIn('冒烟测试', html)
        self.assertNotIn('从当前队列保存', html)
        self.assertNotIn('保存动作模板', html)
        self.assertNotIn('id="ecommerce-import-model"', html)
        self.assertIn('<option value="runninghub" selected>RH</option>', html)
        self.assertIn('<option value="oaihk">HK</option>', html)
        self.assertIn('Nano2-4K｜低价｜¥0.30', html)
        self.assertIn('GPT2-4K｜¥0.16', html)

    def test_frontend_folder_drop_keeps_recursive_relative_paths(self):
        script_path = os.path.join(os.path.dirname(app_module.__file__), 'static', 'js', 'app.js')
        with open(script_path, 'r', encoding='utf-8') as handle:
            script = handle.read()
        self.assertIn('webkitGetAsEntry', script)
        self.assertIn('collectDroppedEcommerceGarmentFiles', script)
        self.assertIn('garment_sources:', script)
        self.assertIn('relative_path: item.relative_path', script)

    def test_compare_last_result_uses_one_supported_garment_switch_path(self):
        script_path = os.path.join(os.path.dirname(app_module.__file__), 'static', 'js', 'app.js')
        with open(script_path, 'r', encoding='utf-8') as handle:
            script = handle.read()
        self.assertNotIn('/api/ecommerce/group-compare?', script)
        self.assertNotIn('navigateEcommerceGarment(', script)
        self.assertEqual(script.count('ecommerceCompareZoomState = {'), 1)
        self.assertIn('const switched = await switchEcommerceCompareGarment(1);', script)
        self.assertEqual(script.count("getElementById('ecommerce-compare-next-garment')?.addEventListener"), 1)
        self.assertEqual(script.count("getElementById('ecommerce-compare-prev-garment')?.addEventListener"), 1)

    def test_compare_canvas_keeps_zoom_and_supports_unbounded_two_axis_pan(self):
        project_dir = os.path.dirname(app_module.__file__)
        with open(os.path.join(project_dir, 'static', 'js', 'app.js'), 'r', encoding='utf-8') as handle:
            script = handle.read()
        with open(os.path.join(project_dir, 'static', 'css', 'style.css'), 'r', encoding='utf-8') as handle:
            styles = handle.read()
        update_source = script.split('function updateEcommerceImageCompare()', 1)[1].split('async function openEcommerceGroupCompare', 1)[0]
        result_nav_source = script.split('async function navigateEcommerceResult(delta)', 1)[1].split("document.getElementById('ecommerce-compare-crop-ref')", 1)[0]
        self.assertNotIn('ecommerceCompareZoomState.reference = 1', update_source)
        self.assertNotIn('ecommerceCompareZoomState.result = 1', update_source)
        self.assertNotIn('ecommerceCompareZoomState.result = 1', result_nav_source)
        self.assertIn('const ecommerceComparePanState = {', script)
        self.assertIn('applyEcommerceComparePan(side);', script)
        self.assertIn('pan.x = cursorX - centerX', script)
        self.assertIn('dragState.panX + dx', script)
        self.assertIn("image.dataset.pendingSourceUrl === nextUrl", script)
        self.assertIn('resultThumbs.hidden = !groupMode;', script)
        self.assertIn('.ecommerce-compare-image-scroll {', styles)
        self.assertIn('overflow: hidden;', styles)
        self.assertIn('touch-action: none;', styles)
        self.assertIn('.ecommerce-compare-thumbnails { width: 100%; height: 80px;', styles)


if __name__ == "__main__":
    unittest.main()
