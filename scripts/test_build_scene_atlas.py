"""Regression coverage for complete-pose extraction, not aesthetic approval."""

from pathlib import Path
import json
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageDraw

from build_scene_atlas import compose, encode_verified_atlas, extract_row, load_row_registrations, ROW_NAMES


class SceneExtractionTests(unittest.TestCase):
    def row(self, count=8):
        image = Image.new("RGBA", (440, 100))
        draw = ImageDraw.Draw(image)
        for index in range(count):
            draw.rectangle((30 + 50 * index, 20, 65 + 50 * index, 79),
                           fill=(25 + index * 25, 90, 80, 255))
        return image

    def extract(self, image, **kwargs):
        with tempfile.TemporaryDirectory(prefix="scene-extraction-") as folder:
            source = Path(folder) / "row.png"
            image.save(source)
            return extract_row(source, **kwargs)

    def reference(self, box=(60, 84, 131, 203)):
        image = Image.new("RGBA", (192, 208))
        ImageDraw.Draw(image).rectangle(box, fill=(50, 90, 70, 255))
        return image

    def test_endpoint_reference_preserves_small_loop_scale(self):
        report = {}
        frames = self.extract(self.row(), report=report, reference_frame=self.reference())
        for frame in frames:
            self.assertEqual(frame.getchannel("A").getbbox(), (60, 84, 132, 204))
        self.assertEqual(report["sharedScale"], 2)
        self.assertEqual(report["registration"]["referenceBbox"], [60, 84, 132, 204])

    def test_endpoint_reference_uses_one_scale_for_all_poses(self):
        source = self.row()
        ImageDraw.Draw(source).rectangle((80, 20, 115, 39), fill=(0, 0, 0, 0))
        frames = self.extract(source, reference_frame=self.reference())
        self.assertEqual(frames[0].getchannel("A").getbbox(), (60, 84, 132, 204))
        self.assertEqual(frames[1].getchannel("A").getbbox(), (60, 124, 132, 204))

    def test_endpoint_reference_preserves_its_center_and_baseline(self):
        frames = self.extract(self.row(), reference_frame=self.reference((40, 60, 111, 179)))
        self.assertEqual(frames[0].getchannel("A").getbbox(), (40, 60, 112, 180))

    def test_endpoint_reference_can_match_nonzero_source_column(self):
        source = self.row()
        ImageDraw.Draw(source).rectangle((80, 20, 115, 39), fill=(0, 0, 0, 0))
        frames = self.extract(source, reference_frame=self.reference((60, 124, 131, 203)),
                              reference_column=1)
        self.assertEqual(frames[0].getchannel("A").getbbox(), (60, 84, 132, 204))
        self.assertEqual(frames[1].getchannel("A").getbbox(), (60, 124, 132, 204))

    def test_endpoint_transform_that_clips_another_pose_is_rejected(self):
        source = self.row()
        ImageDraw.Draw(source).rectangle((80, 20, 115, 49), fill=(0, 0, 0, 0))
        with self.assertRaisesRegex(ValueError, "registration.*fit|fit.*registration"):
            self.extract(source, reference_frame=self.reference(), reference_column=1)

    def test_endpoint_reference_requires_nonempty_safe_rgba_cell(self):
        for reference in (Image.new('RGBA', (192, 208)), Image.new('RGB', (192, 208)),
                          Image.new('RGBA', (191, 208)), self.reference((0, 20, 70, 200))):
            with self.subTest(size=reference.size, mode=reference.mode):
                with self.assertRaisesRegex(ValueError, "reference"):
                    self.extract(self.row(), reference_frame=reference)

    def test_endpoint_reference_rejects_invalid_column(self):
        for column in (-1, 8, True, 1.5):
            with self.subTest(column=column):
                with self.assertRaisesRegex(ValueError, "column"):
                    self.extract(self.row(), reference_frame=self.reference(), reference_column=column)

    def test_registration_file_resolves_reference_relative_to_config(self):
        with tempfile.TemporaryDirectory(prefix='scene-registration-') as folder:
            config = Path(folder) / 'registration.json'
            config.write_text(json.dumps({'night-loop': {'referenceFrame': 'refs/end.png',
                                                          'sourceColumn': 7}}), encoding='utf-8')
            result = load_row_registrations(config, ['night-loop'])
            self.assertEqual(result['night-loop']['referenceFrame'], config.parent / 'refs/end.png')
            self.assertEqual(result['night-loop']['sourceColumn'], 7)

    def test_registration_file_rejects_unknown_rows_and_malformed_entries(self):
        for data in ([], {'unknown': {}}, {'night-enter': {}}, {'night-loop': {}},
                     {'night-loop': {'referenceFrame': '', 'sourceColumn': 0}},
                     {'night-loop': {'referenceFrame': 'a.png', 'sourceColumn': True}},
                     {'night-loop': {'referenceFrame': 'a.png', 'sourceColumn': 8}},
                     {'night-loop': {'referenceFrame': 'a.png', 'sourceColumn': 0, 'extra': 1}}):
            with self.subTest(data=data), tempfile.TemporaryDirectory(prefix='scene-registration-') as folder:
                config = Path(folder) / 'registration.json'
                config.write_text(json.dumps(data), encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'registration'):
                    load_row_registrations(config, ['night-loop'])

    def test_absent_registration_keeps_default_behavior(self):
        self.assertEqual(load_row_registrations(None, ROW_NAMES), {})
        with self.assertRaisesRegex(ValueError, 'reference'):
            self.extract(self.row(), reference_column=2)

    def test_uneven_positions_keep_whole_pose_and_original_order(self):
        frames = self.extract(self.row())
        self.assertEqual(len(frames), 8)
        # Each original pose is 36x60. Shared 200/60 scaling must preserve
        # its entire 120x200 body, including the part across an eighth boundary.
        for index, frame in enumerate(frames):
            self.assertEqual(frame.getchannel("A").getbbox(), (36, 4, 156, 204))
            self.assertEqual(frame.getpixel((96, 104)), (25 + index * 25, 90, 80, 255))

    def test_seven_poses_are_rejected_instead_of_reusing_sliced_fragments(self):
        with self.assertRaisesRegex(ValueError, "8.*pose|pose.*8"):
            self.extract(self.row(7))

    def test_ninth_significant_component_is_rejected(self):
        source = self.row()
        ImageDraw.Draw(source).rectangle((8, 32, 23, 55), fill=(120, 70, 60, 255))
        with self.assertRaisesRegex(ValueError, "8.*pose|pose.*8"):
            self.extract(source)

    def test_touching_neighbor_poses_are_rejected_not_split_blindly(self):
        source = self.row()
        ImageDraw.Draw(source).rectangle((65, 45, 80, 48), fill=(120, 70, 60, 255))
        with self.assertRaisesRegex(ValueError, "8.*pose|pose.*8"):
            self.extract(source)

    def test_outer_canvas_clipping_is_rejected_before_resizing(self):
        for side in ("left", "right", "top", "bottom"):
            with self.subTest(side=side):
                source = self.row()
                boxes = {"left": (0, 25, 30, 65), "right": (415, 25, 439, 65),
                         "top": (35, 0, 55, 20), "bottom": (35, 79, 55, 99)}
                ImageDraw.Draw(source).rectangle(boxes[side], fill=(25, 90, 80, 255))
                with self.assertRaisesRegex(ValueError, "edge|clipp"):
                    self.extract(source)

    def test_tiny_detached_noise_cannot_replace_or_extend_a_pose(self):
        source = self.row()
        ImageDraw.Draw(source).point((2, 2), fill=(220, 50, 50, 255))
        for frame in self.extract(source):
            self.assertEqual(frame.getchannel("A").getbbox(), (36, 4, 156, 204))

    def test_transparent_rgb_is_cleared(self):
        source = self.row()
        pixels = np.asarray(source).copy()
        pixels[pixels[:, :, 3] == 0, :3] = (130, 20, 210)
        for frame in self.extract(Image.fromarray(pixels)):
            rgba = np.asarray(frame)
            self.assertTrue(np.all(rgba[rgba[:, :, 3] == 0, :3] == 0))

    def test_replacing_one_row_preserves_other_visible_pixels(self):
        original = compose({name: self.extract(self.row()) for name in ROW_NAMES})
        replacement = Image.new("RGBA", (192, 208))
        ImageDraw.Draw(replacement).rectangle((90, 30, 102, 100), fill=(99, 80, 70, 150))
        repaired = compose({"work-fatigue-loop": [replacement] * 8}, original)
        before, after = np.asarray(original), np.asarray(repaired)
        self.assertTrue(np.array_equal(before[:9 * 208], after[:9 * 208]))
        self.assertTrue(np.array_equal(before[10 * 208:], after[10 * 208:]))
        self.assertEqual(repaired.getpixel((50, 9 * 208 + 50)), (0, 0, 0, 0))
        self.assertEqual(repaired.getpixel((96, 9 * 208 + 50)), (99, 80, 70, 150))

    def test_webp_roundtrip_checks_actual_encoded_pixels_and_hidden_rgb(self):
        frames = self.extract(self.row())
        atlas = compose({name: frames for name in ROW_NAMES})
        payload, report = encode_verified_atlas(atlas)
        self.assertTrue(payload.startswith(b"RIFF"))
        self.assertTrue(report["encodedWebpPixelExact"])
        self.assertTrue(report["encodedWebpValidated"])
        self.assertTrue(all(frame["hiddenRgbPixels"] == 0 for frame in report["frames"]))

    def test_partial_or_wrong_geometry_rows_are_rejected(self):
        base = Image.new("RGBA", (1536, 3744))
        good = Image.new("RGBA", (192, 208))
        for frames in ([good] * 7, [Image.new("RGB", (192, 208))] * 8,
                       [Image.new("RGBA", (191, 208))] * 8):
            with self.subTest(count=len(frames), mode=frames[0].mode, size=frames[0].size):
                with self.assertRaises(ValueError):
                    compose({"work-fatigue-loop": frames}, base)

    def test_invalid_base_or_unknown_row_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "base atlas"):
            compose({}, Image.new("RGBA", (1536, 208)))
        with self.assertRaisesRegex(ValueError, "unknown scene row"):
            compose({"unknown": []})

    def test_blank_encoded_atlas_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "validation failed"):
            encode_verified_atlas(Image.new("RGBA", (1536, 3744)))


if __name__ == "__main__":
    unittest.main()
