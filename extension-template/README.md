# my-pi-extension

Describe what your Pi extension does in one sentence.

> Created from `extension-template`. Rename `my-pi-extension` everywhere
> (`package.json`, this README) and delete this note.

## Install

```bash
pi install ./my-pi-extension
# or, once published:
# pi install npm:my-pi-extension
```

## Usage

```bash
pi --extension ./extensions/hello.ts
```

Then run `/hello` inside Pi.

## Development

```bash
npm install
pi -e .
```

Extension `.ts` changes need a Pi restart (clear the jiti cache first:
`rm -rf $TMPDIR/jiti`).

## License

MIT
