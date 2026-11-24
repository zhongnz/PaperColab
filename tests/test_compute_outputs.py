import json
import unittest
from compute.contract import extract_outputs, validate_outputs, OUTPUT_PREFIX


class StructuredOutputTests(unittest.TestCase):
    def test_supported_data_only(self):
        table={"name":"t","kind":"table","title":"Example <script>","columns":["metric"],"rows":[[None],[0.5],["<img src=x>"]]}
        chart={"name":"s","kind":"series","title":"Trend","x_label":"X","y_label":"Y","points":[[1,2],[2,3]]}
        self.assertEqual(extract_outputs("normal log\n"+OUTPUT_PREFIX+json.dumps(table)+"\n"+OUTPUT_PREFIX+json.dumps(chart)),[table,chart])
        for invalid in ([table,table],[{**table,"rows":[[1,2]]}],[{**table,"name":"../file"}],
                        [{**table,"columns":["x","x"],"rows":[[1,2]]}],
                        [{**chart,"points":[[1,float("nan")],[2,3]]}],
                        [{**chart,"points":[[True,1],[2,3]]}],
                        [{**chart,"svg":"<script>"}],[{**table,"rows":[["x"*200]]*200,"title":"x\n"}]):
            with self.subTest(invalid=str(invalid)[:80]):
                with self.assertRaises(ValueError):validate_outputs(invalid)
        with self.assertRaises(ValueError):extract_outputs(OUTPUT_PREFIX+"not JSON")
