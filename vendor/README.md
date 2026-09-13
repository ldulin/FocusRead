# vendor/

Third-party libraries the document reader depends on. **They are not committed
to this repository** - run the installer once after cloning:

```bash
./scripts/fetch-vendor.sh
```

| Library | What it does | Licence |
| --- | --- | --- |
| [pdf.js](https://github.com/mozilla/pdf.js) | reads PDFs and rebuilds their text | Apache-2.0 |
| [mammoth.js](https://github.com/mjml-io/mammoth.js) | converts `.docx` to HTML | BSD-2-Clause |

Why they are downloaded rather than committed:

- Together they are several megabytes, most of it pdf.js's CJK character maps.
- Manifest V3 forbids loading scripts from a CDN at runtime, so they cannot be
  referenced remotely - they have to be real files in the extension folder.
- Keeping them out of git means this repository ships only its own code, under
  its own licence.

Everything except the PDF and Word reader works without them.
