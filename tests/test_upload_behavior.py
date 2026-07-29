import base64
import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

import app as app_module


class UploadBehaviorTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.old_data_dir = app_module.DATA_DIR
        self.old_images_dir = app_module.IMAGES_DIR
        app_module.DATA_DIR = os.path.join(self.tempdir.name, "data")
        app_module.IMAGES_DIR = os.path.join(self.tempdir.name, "images")
        os.makedirs(app_module.DATA_DIR, exist_ok=True)
        os.makedirs(app_module.IMAGES_DIR, exist_ok=True)
        with open(os.path.join(app_module.DATA_DIR, "model_config.json"), "w", encoding="utf-8") as f:
            json.dump({"upload_short_edge": 1536, "upload_mode": "adaptive"}, f)
        self.client = app_module.app.test_client()

    def tearDown(self):
        app_module.DATA_DIR = self.old_data_dir
        app_module.IMAGES_DIR = self.old_images_dir
        self.tempdir.cleanup()

    @staticmethod
    def make_png(width, height, color=(30, 120, 220)):
        buf = io.BytesIO()
        Image.new("RGB", (width, height), color).save(buf, format="PNG")
        buf.seek(0)
        return buf

    def test_preserve_original_upload_keeps_pixel_dimensions_and_format(self):
        response = self.client.post(
            "/api/upload-image",
            data={
                "file": (self.make_png(321, 123), "wide-reference.png"),
                "preserve_original": "1",
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertTrue(payload["preserved_original"])
        self.assertTrue(payload["url"].endswith(".png"))
        saved_path = os.path.join(app_module.IMAGES_DIR, os.path.basename(payload["url"]))
        with Image.open(saved_path) as saved:
            self.assertEqual(saved.size, (321, 123))

    def test_configured_original_mode_also_preserves_dimensions(self):
        with open(os.path.join(app_module.DATA_DIR, "model_config.json"), "w", encoding="utf-8") as f:
            json.dump({"upload_short_edge": 3072, "upload_mode": "original"}, f)
        response = self.client.post(
            "/api/upload-image",
            data={"file": (self.make_png(157, 289), "portrait.png")},
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        saved_path = os.path.join(app_module.IMAGES_DIR, os.path.basename(payload["url"]))
        with Image.open(saved_path) as saved:
            self.assertEqual(saved.size, (157, 289))

    def test_batch_adaptive_upload_auto_crops_landscape_to_four_three(self):
        response = self.client.post(
            "/api/upload-image",
            data={
                "file": (self.make_png(401, 201), "wide.png"),
                "auto_crop": "1",
            },
            content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 201)
        payload = response.get_json()
        self.assertTrue(payload["auto_cropped"])
        self.assertEqual(payload["crop_ratio"], "4:3")
        self.assertEqual((payload["width"], payload["height"]), (2048, 1536))

    def test_result_download_reports_original_pixel_dimensions(self):
        raw = self.make_png(3584, 4800).getvalue()

        class FakeResponse:
            status_code = 200
            headers = {"Content-Type": "image/png"}

            @staticmethod
            def iter_content(chunk_size=8192):
                for start in range(0, len(raw), chunk_size):
                    yield raw[start:start + chunk_size]

        with patch.object(app_module.requests, "get", return_value=FakeResponse()):
            response = self.client.post(
                "/api/download-image",
                json={"url": "https://v3.fal.media/files/test/result.png"},
            )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()["data"]
        self.assertEqual((payload["width"], payload["height"]), (3584, 4800))

    def test_auto_preprocessing_does_not_crop_reference_image(self):
        original = Image.new("RGB", (777, 333))
        processed = app_module._smart_crop_to_ratio(original, "auto")
        self.assertEqual(processed.size, (777, 333))

    def test_gpt_size_check_reports_mismatch_without_upscaling(self):
        raw = self.make_png(640, 480).getvalue()
        original_b64 = base64.b64encode(raw).decode("ascii")
        result = app_module._inspect_gpt_result_size(
            {"data": [{"b64_json": original_b64}]},
            "3840x2160",
        )
        self.assertEqual(result["data"][0]["b64_json"], original_b64)
        self.assertTrue(result["sample_factory_size_mismatch"])
        self.assertEqual(
            result["sample_factory_size_check"][0]["actual_size"],
            "640x480",
        )

    def test_multi_queue_count_persists_up_to_twenty(self):
        response = self.client.put(
            "/api/queue-data",
            json={
                "queues": [{} for _ in range(20)],
                "queueCount": 20,
                "activeQueue": 19,
                "queueMode": "multi",
                "slots": [],
            },
        )
        self.assertEqual(response.status_code, 200)
        restored = self.client.get("/api/queue-data").get_json()
        self.assertEqual(restored["queueCount"], 20)
        self.assertEqual(len(restored["queues"]), 20)

    def test_multi_queue_count_rejects_more_than_twenty(self):
        response = self.client.put(
            "/api/queue-data",
            json={
                "queues": [{} for _ in range(21)],
                "queueCount": 21,
                "activeQueue": 0,
                "queueMode": "multi",
                "slots": [],
            },
        )
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
