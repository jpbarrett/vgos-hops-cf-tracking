// Where the export is. The viewer computes nothing itself; everything comes
// from these files (see EXPORT_SCHEMA.md in the export's producer).
//
// full-data/ beside the page: on the published site, where update_vgos.py
// writes it, and locally after `./export_web.py -o webapp/full-data` (kept
// out of git). Override per visit with ?data=<url>, e.g.
//   http://localhost:8000/?data=https://<user>.github.io/<site-repo>/full-data/
export const DEFAULT_DATA_URL = 'full-data/';

const slash = (url) => (url.endsWith('/') ? url : url + '/');

export function dataUrl() {
  return slash(new URLSearchParams(location.search).get('data') || DEFAULT_DATA_URL);
}
