// The DSH client loader keys factories by the id in window.__DSH_BOOT__.entries[], which is
// the package name a plugin was installed as. A hardcoded id therefore breaks one install
// flavour (profile link vs npm) and aborts the whole web boot. This test pins the resolution
// logic against a synthetic boot manifest.
const vm = require('vm')
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'mesh-waker', 'client.js'), 'utf8')

function resolveId({ scriptSrc, entries, currentScript = true }) {
  const captured = []
  const sandbox = {
    console,
    document: { currentScript: currentScript ? { src: scriptSrc } : null },
    window: {
      __DSH_BOOT__: { entries },
      __ModuleLoader__: { load: (registration) => captured.push(registration) },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  return captured.length ? captured[0].id : '<no registration>'
}

const cases = [
  {
    name: 'profile link install',
    input: {
      scriptSrc: 'dsh-app://app/plugins/%40local%2Fdsh-mesh-waker/client.js?rev=abc',
      entries: [{ id: '@local/dsh-mesh-waker', url: 'dsh-app://app/plugins/%40local%2Fdsh-mesh-waker/client.js?rev=abc' }],
    },
    expect: '@local/dsh-mesh-waker',
  },
  {
    name: 'npm install',
    input: {
      scriptSrc: 'dsh-app://app/plugins/dsh-mesh-waker/client.js?rev=def',
      entries: [{ id: 'dsh-mesh-waker', url: 'dsh-app://app/plugins/dsh-mesh-waker/client.js?rev=def' }],
    },
    expect: 'dsh-mesh-waker',
  },
  {
    name: 'both installed, current script is the link',
    input: {
      scriptSrc: 'dsh-app://app/plugins/%40local%2Fdsh-mesh-waker/client.js?rev=abc',
      entries: [
        { id: '@local/dsh-mesh-waker', url: 'dsh-app://app/plugins/%40local%2Fdsh-mesh-waker/client.js?rev=abc' },
        { id: 'dsh-mesh-waker', url: 'dsh-app://app/plugins/dsh-mesh-waker/client.js?rev=def' },
      ],
    },
    expect: '@local/dsh-mesh-waker',
  },
  {
    name: 'module-script transport without currentScript, single match',
    input: {
      scriptSrc: '',
      currentScript: false,
      entries: [{ id: '@local/dsh-mesh-waker', url: 'dsh-app://app/plugins/%40local%2Fdsh-mesh-waker/client.js?rev=abc' }],
    },
    expect: '@local/dsh-mesh-waker',
  },
  {
    name: 'no manifest match falls back to the npm name',
    input: { scriptSrc: 'dsh-app://app/plugins/unknown/client.js', entries: [] },
    expect: 'dsh-mesh-waker',
  },
]

let failed = 0
for (const testCase of cases) {
  const got = resolveId(testCase.input)
  const ok = got === testCase.expect
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${testCase.name}: ${got}`)
}

if (failed) {
  console.error(`${failed} case(s) failed`)
  process.exit(1)
}
console.log(`all ${cases.length} cases passed`)
