# Personal Assets & Liabilities Management System

Open `index.html` in a modern browser. For the most reliable browser APIs and PDF handling, serve the folder through a local web server:

```powershell
cd "D:\Web App"
python -m http.server 8080
```

Then visit `http://localhost:8080`.

## Data storage

- Records, categories, subcategories, settings, PDF metadata, and PDF binary data are stored in IndexedDB.
- Cross-device transfer is performed only through ZIP backup and restore.
- Backups contain `backup.json`, `metadata.json`, and original PDF files under `documents/`.
- Use Settings > Excel Migration to import `Assets & Liabilities.xlsx`. Worksheets are mapped to the default asset and liability structure.
