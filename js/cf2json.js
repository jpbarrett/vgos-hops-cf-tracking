// Parses a control file in the page, with HOPS' own parser compiled to
// WebAssembly (wasm/, built by scripts/build_cf2json_wasm.sh), so the result
// is the parse fourfit performs. Fetched the first time a file is parsed, so
// a reader who never imports one does not download it.

// HOPS colours its messages for a terminal
const ANSI_COLOUR = /\x1b\[[0-9;]*m/g;

export class ControlFileError extends Error {}

// what the parser has said during the current parse
let messages = [];
// the module, once it is being loaded
let loading = null;

function collectMessage(line) {
  messages.push(line.replace(ANSI_COLOUR, '').trim());
}

async function loadParser() {
  const { default: createModule } = await import('../wasm/cf2json.mjs');
  return createModule({ print: collectMessage, printErr: collectMessage });
}

function parser() {
  if (loading === null) {
    loading = loadParser().catch((err) => {
      // let the next attempt try again rather than keeping the failure
      loading = null;
      throw new ControlFileError(`could not load the control file parser: ${err.message}`);
    });
  }
  return loading;
}

// the text of a control file -> what cf2json would write for it. Throws a
// ControlFileError for a file that does not parse, whose message is the
// parser's diagnostic, naming the offending line and token
export async function parseControlFile(text) {
  const module = await parser();
  messages = [];
  const doc = JSON.parse(module.parse(text));
  if (doc.error !== undefined) {
    const fatal = messages.filter((line) => line.includes('FATAL'));
    throw new ControlFileError(fatal.length > 0 ? fatal.join('\n') : doc.error);
  }
  return doc;
}
