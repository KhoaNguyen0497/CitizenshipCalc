# NZ Citizenship Presence Calculator

A static, no-build page that tracks the NZ citizenship presence requirement: enough
days in New Zealand over the 5 years before you apply, with a minimum in each of
those years. Reference: [govt.nz presence requirements](https://www.govt.nz/browse/passports-citizenship-and-identity/nz-citizenship/requirements-for-nz-citizenship/presence-requirements/).

This is a personal planning tool, not legal advice - double-check the current
rules on govt.nz before relying on it.

## Files

- `index.html`, `style.css`, `script.js` - the page. No build step, no dependencies.
- `data.json` - optional prefill data, read once on page load. Edit the values below
  and reload the page; nothing is ever written back to this file from the browser.

```json
{
  "residencyDate": "2022-03-15",
  "citizenshipDate": "",
  "travels": [
    { "from": "2023-06-01", "to": "2023-06-20", "note": "Family visit" }
  ],
  "requirements": {
    "windowYears": 5,
    "totalDaysRequired": 1350,
    "yearlyDaysRequired": 240
  }
}
```

- `residencyDate`: the date permanent residency was granted.
- `citizenshipDate`: leave blank to default to residency date + 5 years, or set a
  specific planned application date.
- `travels`: each entry is a trip abroad. The day you leave and the day you're
  back both count as days in NZ - only the days strictly in between count as
  time out of the country.
- `requirements`: the presence rule itself. Defaults are the standard current
  values; these are also editable directly on the page under "Requirements".

## Running locally

Because the page fetches `data.json` with `fetch()`, opening `index.html`
directly from disk (`file://`) will fail in most browsers due to CORS
restrictions on local files. Serve it instead, e.g.:

```sh
python3 -m http.server 8000
```

then open `http://localhost:8000`.

## Hosting on GitHub Pages

1. Push this repo to GitHub.
2. In the repo settings, enable **Pages** for the branch/folder this lives in
   (e.g. `main` / root).
3. GitHub Pages serves over HTTPS, so `fetch('data.json')` works there without
   any local server.
