#!/usr/bin/env python3
"""
Generates the two bundled sample forms that DEMO MODE reads.

Why generate rather than ship a photo:
  • the mock field extractor must return bounding boxes that line up perfectly
    with the annotated overlay, and that is only guaranteed if the same
    constants produce both;
  • no third-party image licence questions in a public MIT repo;
  • the file sizes stay ~120 KB each, which is what a real compressed phone
    photo looks like.

Outputs
  public/samples/scholarship-form.jpg   (page 1 — the form to fill)
  public/samples/scholarship-form-instructions.jpg (the official instruction page
    the cloud verify pass reads)
  public/samples/bank-form.jpg          (a second, different form — the Answer
    Vault "fills 80% instantly" demo)
  src/data/sampleLayouts.ts             (field boxes + labels, consumed by the mocks)
"""

import json
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_IMG = os.path.join(ROOT, "public", "samples")
OUT_TS = os.path.join(ROOT, "src", "data", "sampleLayouts.ts")
os.makedirs(OUT_IMG, exist_ok=True)

W, H = 1240, 1754  # A4 @ 150dpi
INK = (28, 32, 38)
MUTED = (95, 100, 110)
BOX = (60, 60, 62)
PAPER = (252, 251, 247)
LINE = (150, 154, 162)


def font(size, bold=False):
    for name in (
        ("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"),
        ("DejaVuSerif-Bold.ttf" if bold else "DejaVuSerif.ttf"),
    ):
        for base in ("/usr/share/fonts/truetype/dejavu/",):
            p = os.path.join(base, name)
            if os.path.exists(p):
                return ImageFont.truetype(p, size)
    return ImageFont.load_default()


class Form:
    """Draws onto a tall canvas, then scales uniformly to A4 so that a form with
    many fields never runs off the page. Field boxes are recorded as fractions
    of the DRAWN canvas, which survives the uniform scale unchanged."""

    def __init__(self, title, subtitle, reference):
        self.W = W
        self.HDRAW = 3200
        self.img = Image.new("RGB", (self.W, self.HDRAW), PAPER)
        self.d = ImageDraw.Draw(self.img)
        self.fields = []
        self.y = 0
        self.title = title
        self.subtitle = subtitle
        self.reference = reference

    def header(self):
        d = self.d
        d.rectangle([30, 30, self.W - 30, self.HDRAW - 30], outline=BOX, width=3)
        d.rectangle([30, 30, self.W - 30, 172], outline=BOX, width=3)
        d.text((70, 50), "GOVERNMENT OF INDIA", font=font(22, True), fill=MUTED)
        tf = font(34, True)
        while d.textlength(self.title, font=tf) > self.W - 480:
            tf = font(tf.size - 2, True)
        d.text((70, 80), self.title, font=tf, fill=INK)
        d.text((70, 124), self.subtitle, font=font(19), fill=MUTED)
        d.text((self.W - 400, 54), self.reference, font=font(18, True), fill=INK)
        d.text((self.W - 400, 80), "Form No. SPC/2026/PM-01", font=font(16), fill=MUTED)
        d.text((self.W - 400, 104), "Free of cost - no fee required", font=font(16), fill=MUTED)
        d.text((self.W - 400, 128), "Office use only: CIF ____", font=font(15), fill=MUTED)
        self.y = 196

    def section(self, text):
        d = self.d
        self.y += 12
        d.rectangle([60, self.y, self.W - 60, self.y + 38], fill=(232, 236, 242), outline=BOX, width=1)
        d.text((76, self.y + 9), text, font=font(19, True), fill=INK)
        self.y += 52

    def field(self, key, label, ftype="text", hint="", required=True, width=1.0, options=None):
        d = self.d
        label_font = font(20)
        x0 = 70
        if options:
            # checkbox / choice row: label on top, ticks underneath
            d.text((x0, self.y + 4), label, font=label_font, fill=INK)
            tw = d.textlength(label, font=label_font)
            if required:
                d.text((x0 + tw + 6, self.y + 2), "*", font=font(22, True), fill=(180, 40, 40))
            if hint:
                d.text((x0 + tw + 26, self.y + 8), hint, font=font(15), fill=MUTED)
            cy = self.y + 38
            cx = x0 + 12
            for opt in options:
                d.rectangle([cx, cy, cx + 20, cy + 20], outline=BOX, width=2)
                d.text((cx + 30, cy + 1), opt, font=font(17), fill=INK)
                cx += 40 + d.textlength(opt, font=font(17)) + 46
            bx, by, bw, bh = x0, cy - 4, (self.W - 140) * width, 28
            self._record(key, label, ftype, hint, required, bx, by, bw, bh, options)
            self.y += 84
            return

        label_w = 520
        d.text((x0, self.y + 8), label, font=label_font, fill=INK)
        if required:
            tw = d.textlength(label, font=label_font)
            d.text((x0 + tw + 6, self.y + 6), "*", font=font(22, True), fill=(180, 40, 40))
        bx = x0 + label_w
        bw = (self.W - 70) - bx
        by = self.y + 6
        bh = 34
        d.rectangle([bx, by, bx + bw, by + bh], outline=BOX, width=2)
        if ftype == "signature":
            d.line([bx + 20, by + bh - 8, bx + bw - 20, by + bh - 8], fill=LINE, width=1)
        if hint:
            d.text((x0, self.y + 44), hint, font=font(15), fill=MUTED)
            self.y += 82
        else:
            self.y += 64
        self._record(key, label, ftype, hint, required, bx, by, bw, bh, None)

    def _record(self, key, label, ftype, hint, required, bx, by, bw, bh, options):
        rec = {
            "id": key,
            "label": label,
            "type": ftype,
            "required": required,
            "hint": hint,
            "box": {
                "x": round(bx / self.W, 4),
                "y": round(by / self.HDRAW, 4),
                "w": round(bw / self.W, 4),
                "h": round(bh / self.HDRAW, 4),
            },
        }
        if options:
            rec["options"] = options
        self.fields.append(rec)

    def declaration(self):
        d = self.d
        self.y += 14
        d.rectangle([60, self.y, self.W - 60, self.y + 118], outline=LINE, width=1)
        d.text((76, self.y + 12), "DECLARATION", font=font(18, True), fill=INK)
        for i, line in enumerate(
            [
                "I hereby declare that the information given above is true to the best of my knowledge.",
                "I understand that any false statement will lead to cancellation of the scholarship",
                "and recovery of the amount already paid.",
            ]
        ):
            d.text((76, self.y + 42 + i * 22), line, font=font(15), fill=INK)
        d.text((self.W - 380, self.y + 42), "Signature of Applicant", font=font(15), fill=MUTED)
        d.line([self.W - 380, self.y + 90, self.W - 90, self.y + 90], fill=BOX, width=2)
        self.y += 130

    def save(self, name):
        """Crop to content, then scale uniformly so height == H (A4 ratio)."""
        content_h = min(self.HDRAW - 30, self.y + 60)
        footer_y = content_h - 34
        self.d.text(
            (70, footer_y),
            "Page 1 of 1  |  Attach: income certificate, caste certificate, bank passbook, marksheet",
            font=font(14),
            fill=MUTED,
        )
        cropped = self.img.crop((0, 0, self.W, content_h))
        scale = H / content_h
        final = cropped.resize((round(self.W * scale), H), Image.LANCZOS)
        # Fractional boxes stay valid because the scale is uniform in x and y
        # when expressed against the cropped canvas -> but the final width
        # differs, so re-normalise against the CROPPED canvas (unchanged aspect
        # of the recorded fractions: x/W_draw, y/H_draw).
        path = os.path.join(OUT_IMG, name)
        final.save(path, "JPEG", quality=84, optimize=True)
        return path


def build_scholarship():
    f = Form(
        "POST MATRIC SCHOLARSHIP 2026-27",
        "For SC / ST / OBC students — Ministry of Social Justice & Empowerment",
        "Application Form",
    )
    f.header()
    f.section("A. PERSONAL DETAILS")
    f.field("full_name", "Name of Applicant (as per matric certificate)", "text", required=True)
    f.field("father_name", "Father's Name", "text", required=True)
    f.field("mother_name", "Mother's Name", "text", required=False)
    f.field("date_of_birth", "Date of Birth (DD/MM/YYYY)", "date", required=True)
    f.field("gender", "Gender", "select", required=True, options=["Male", "Female", "Other"])
    f.field("category", "Category", "select", required=True, options=["SC", "ST", "OBC", "General"])
    f.field("mobile", "Mobile Number (10 digits)", "phone", "Do not add +91 or spaces", required=True)
    f.field("aadhaar", "Aadhaar Number (12 digits)", "text", "Optional at this stage", required=False)

    f.section("B. ADDRESS")
    f.field("address", "Permanent Address (House, Street, Village/Town)", "text", required=True)
    f.field("district", "District", "text", required=True)
    f.field("state", "State", "text", required=True)
    f.field("pincode", "PIN Code (6 digits)", "number", required=True)

    f.section("C. ACADEMIC DETAILS")
    f.field("institution_name", "Name of School / College", "text", required=True)
    f.field("course", "Course / Class", "text", "e.g. B.A. Part I", required=True)
    f.field("roll_number", "Roll Number / Registration No.", "text", required=False)
    f.field("percentage", "Percentage Marks in Last Exam", "number", "in figures only", required=True)

    f.section("D. INCOME & BANK DETAILS")
    f.field("annual_family_income", "Annual Family Income (in rupees)", "number", "in figures only, not monthly", required=True)
    f.field("bank_account", "Bank Account Number", "text", required=True)
    f.field("ifsc", "IFSC Code", "text", "11 characters", required=True)

    f.section("E. DECLARATION & SIGNATURE")
    f.field("declaration", "I agree to the declaration below", "checkbox", required=True, options=["Yes, I agree"])
    f.declaration()
    path = f.save("scholarship-form.jpg")
    return f.fields, path


def build_instructions():
    f = Form(
        "POST MATRIC SCHOLARSHIP 2026-27",
        "Instructions for filling the application form - read carefully",
        "Instruction Page",
    )
    f.header()
    lines = [
        ("1.", "Eligibility: applicant must belong to SC, ST or OBC category and have an annual family income of Rs. 2,50,000 or less from all sources."),
        ("2.", "Income must be written as ANNUAL family income, in figures only. Do not write monthly income and do not write the amount in words. Applications showing monthly income will be rejected."),
        ("3.", "Date of birth must be in DD/MM/YYYY format exactly as printed on the matriculation certificate."),
        ("4.", "Mobile number must be 10 digits without +91, without spaces and without hyphens. This number receives all OTP and status messages."),
        ("5.", "Aadhaar number, if provided, must be exactly 12 digits. Aadhaar is optional at the application stage but required before disbursal."),
        ("6.", "PIN code must be 6 digits and must match the district and state given in the address."),
        ("7.", "Percentage marks must be in figures only, rounded to two decimal places, and must refer to the last qualifying examination."),
        ("8.", "Bank account must be in the name of the applicant. Joint accounts and minor accounts are not accepted. IFSC code is 11 characters: 4 letters, then 0, then 6 alphanumeric characters."),
        ("9.", "Original documents required at verification: matriculation certificate, income certificate issued by the competent authority, caste certificate, bank passbook first page and last marksheet."),
        ("10.", "Incomplete applications will be rejected without any intimation. The applicant is responsible for the correctness of every entry."),
        ("11.", "Last date for submission: 31 January 2027. Late applications will not be considered."),
    ]
    y = f.y
    d = f.d
    for num, text in lines:
        d.text((70, y), num, font=font(19, True), fill=INK)
        words = text.split()
        cur = ""
        for w in words:
            trial = (cur + " " + w).strip()
            if d.textlength(trial, font=font(19)) > f.W - 240:
                d.text((120, y), cur, font=font(19), fill=INK)
                y += 30
                cur = w
            else:
                cur = trial
        if cur:
            d.text((120, y), cur, font=font(19), fill=INK)
        y += 44
    f.y = y + 10
    d.text(
        (70, f.y),
        "Office of the Director, Social Welfare  |  helpline 1800-000-000 (toll free)",
        font=font(15),
        fill=MUTED,
    )
    f.y += 40
    f.save("scholarship-form-instructions.jpg")


def build_bank_form():
    f = Form(
        "PM JAN DHAN ACCOUNT — OPENING FORM",
        "State Bank of Bharat — Customer Information Sheet (CIF)",
        "Account Form",
    )
    f.header()
    f.section("A. APPLICANT")
    f.field("full_name", "Applicant's Full Name", "text", required=True)
    f.field("father_name", "Father's Name", "text", required=False)
    f.field("date_of_birth", "Date of Birth (DD/MM/YYYY)", "date", required=True)
    f.field("mobile", "Mobile Number (10 digits)", "phone", required=True)
    f.field("aadhaar", "Aadhaar Number (12 digits)", "text", required=True)
    f.field("pan", "PAN (if available)", "text", required=False)
    f.section("B. ADDRESS")
    f.field("address", "Residential Address", "text", required=True)
    f.field("pincode", "PIN Code (6 digits)", "number", required=True)
    f.field("state", "State", "text", required=True)
    f.section("C. OCCUPATION & INCOME")
    f.field("occupation", "Occupation", "text", "e.g. student, farmer, daily wage", required=True)
    f.field("annual_family_income", "Annual Income (in rupees)", "number", "in figures only", required=True)
    f.field("category", "Category", "select", required=False, options=["SC", "ST", "OBC", "General"])
    f.section("D. NOMINATION")
    f.field("nominee_name", "Nominee Name", "text", required=False)
    f.field("declaration", "I have read the RBI KYC guidelines", "checkbox", required=True, options=["Yes"])
    path = f.save("bank-form.jpg")
    return f.fields, path


def main():
    sch_fields, sch_path = build_scholarship()
    build_instructions()
    bank_fields, bank_path = build_bank_form()

    ts = ["/**",
          " * AUTO-GENERATED by scripts/make-samples.py — do not edit by hand.",
          " *",
          " * Field geometry for the bundled sample forms. The DEMO MODE mock",
          " * extractor returns these so that the annotated overlay drawn over the",
          " * sample image lines up pixel-for-pixel. In LIVE mode the real model",
          " * reads the image and returns its own boxes.",
          " */",
          "",
          "import type { ExtractedField } from '../lib/types';",
          "",
          "export interface SampleFormLayout {",
          "  image: string;",
          "  title: string;",
          "  formType: string;",
          "  authority: string;",
          "  fields: Array<Omit<ExtractedField, 'confidence'>>;",
          "}",
          "",
          f"export const SCHOLARSHIP_SAMPLE: SampleFormLayout = {json.dumps({'image': 'samples/scholarship-form.jpg', 'title': 'POST MATRIC SCHOLARSHIP 2026-27', 'formType': 'scholarship', 'authority': 'Ministry of Social Justice & Empowerment', 'fields': sch_fields}, indent=2, ensure_ascii=False)};",
          "",
          f"export const BANK_SAMPLE: SampleFormLayout = {json.dumps({'image': 'samples/bank-form.jpg', 'title': 'PM JAN DHAN ACCOUNT — OPENING FORM', 'formType': 'bank', 'authority': 'State Bank of Bharat', 'fields': bank_fields}, indent=2, ensure_ascii=False)};",
          "",
          "export const SAMPLE_INSTRUCTIONS_IMAGE = 'samples/scholarship-form-instructions.jpg';",
          "",
          "export const SAMPLES = [",
          "  { key: 'scholarship', label: 'Scholarship form (page 1)', image: SCHOLARSHIP_SAMPLE.image, layout: SCHOLARSHIP_SAMPLE },",
          "  { key: 'bank', label: 'Bank account form', image: BANK_SAMPLE.image, layout: BANK_SAMPLE },",
          "  { key: 'instructions', label: 'Instruction page (for cloud verify)', image: SAMPLE_INSTRUCTIONS_IMAGE, layout: null },",
          "] as const;",
          ""]
    with open(OUT_TS, "w", encoding="utf-8") as fh:
        fh.write("\n".join(ts))

    print("wrote", sch_path)
    print("wrote", os.path.join(OUT_IMG, "scholarship-form-instructions.jpg"))
    print("wrote", bank_path)
    print("wrote", OUT_TS)
    print("scholarship fields:", len(sch_fields), "bank fields:", len(bank_fields))


if __name__ == "__main__":
    main()
