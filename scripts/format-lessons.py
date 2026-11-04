import json
import sys

# Pretty-print lesson.json with one line per word / drill item / exercise part.
INLINE_LISTS = {'words', 'items', 'parts', 'audio', 'sources'}


def dump(v, indent=0, key=None):
    pad = '  ' * indent
    if isinstance(v, dict):
        if not v:
            return '{}'
        inner = ',\n'.join(f'{pad}  {json.dumps(k, ensure_ascii=False)}: {dump(x, indent + 1, k)}' for k, x in v.items())
        return '{\n' + inner + '\n' + pad + '}'
    if isinstance(v, list):
        if not v:
            return '[]'
        if key in INLINE_LISTS:
            inner = ',\n'.join(f'{pad}  {json.dumps(x, ensure_ascii=False)}' for x in v)
        else:
            inner = ',\n'.join(f'{pad}  {dump(x, indent + 1)}' for x in v)
        return '[\n' + inner + '\n' + pad + ']'
    return json.dumps(v, ensure_ascii=False)


for path in sys.argv[1:]:
    d = json.load(open(path))
    open(path, 'w').write(dump(d) + '\n')
    assert json.load(open(path)) == d
    print('formatted', path)
