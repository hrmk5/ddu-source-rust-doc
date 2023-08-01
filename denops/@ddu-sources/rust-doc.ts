import {
  BaseSource,
  Context,
  Item,
} from "https://deno.land/x/ddu_vim@v1.13.0/types.ts";
import { Denops, fn } from "https://deno.land/x/ddu_vim@v1.13.0/deps.ts";
import * as path from "https://deno.land/std@0.165.0/path/mod.ts#^";
import { walk } from "https://deno.land/std@0.165.0/fs/walk.ts#^";

// 1. Output of `rustup doc --path`
// 2. $HOME/.rustup/toolchains/stable-*
// 3. $HOME/.rustup/toolchains/nightly-*
// 4. $HOME/.rustup/toolchains/share/doc/rust/html
async function findStdDocDir(): Promise<string | null> {
  const cmd = new Deno.Command("rustup", { args: ["doc", "--path"] });
  try {
    const { success, stdout } = await cmd.output();
    if (success) {
      const indexFile = new TextDecoder().decode(stdout).trim();
      return path.dirname(indexFile);
    }
  } catch (_e) {
    // Do nothing
  }
  const homeDir = Deno.env.get("HOME");
  if (homeDir != null) {
    const toolChainsDir = path.join(homeDir, ".rustup/toolchains");
    let dir: string | null = null;
    for await (const entry of Deno.readDir(toolChainsDir)) {
      if (entry.isDirectory && entry.name.startsWith("stable-")) {
        dir = entry.name;
        break;
      }
    }
    if (dir == null) {
      for await (const entry of Deno.readDir(toolChainsDir)) {
        if (entry.isDirectory && entry.name.startsWith("nightly-")) {
          dir = entry.name;
        }
      }
    }
    return dir && path.join(dir, "share/doc/rust/html/");
  }
  return null;
}

async function fsExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch (_e) {
    return false;
  }
}

async function findCargoProjectDir(p: string): Promise<string | null> {
  if (p === "/" || p === "." || p == "") return null;
  const tomlFile = path.join(p, "Cargo.toml");
  if (await fsExists(tomlFile)) {
    return path.resolve(p);
  } else {
    return await findCargoProjectDir(path.dirname(p));
  }
}

async function findDocDirs(p: string): Promise<string[]> {
  const docs = [];
  const stdDocDir = await findStdDocDir();
  if (stdDocDir != null && await fsExists(stdDocDir)) {
    docs.push(stdDocDir);
  }
  const projectRootDir = await findCargoProjectDir(p);
  if (projectRootDir != null) {
    const docDir = path.join(projectRootDir, "target/doc/");
    if (await fsExists(docDir)) {
      docs.push(docDir);
    }
  }
  return docs;
}

function stripDir(f: string, dir: string): string {
  if (!dir.endsWith("/")) dir += "/";
  return f.replace(new RegExp("^" + dir), "");
}

const ITEM_KINDS = [
  "module",
  "struct",
  "trait",
  "macro",
  "fn",
  "type",
  "enum",
  "keyword",
  "constant",
  "primitive",
  "traitalias",
] as const;
type ItemKind = typeof ITEM_KINDS[number];

type DocItem = {
  kind: ItemKind;
  module: string | null;
  name: string;
  docDir: string;
};

async function* getDocItems(docDir: string): AsyncIterableIterator<DocItem> {
  for await (
    const entry of walk(docDir, { exts: ["html"] })
  ) {
    if (entry.isFile) {
      const p = stripDir(entry.path, docDir);
      if (p.startsWith("src/")) continue;
      if (entry.name === "index.html") {
        const module = path.basename(path.dirname(p));
        if (module === ".") continue;
        const parentModuleDir = path.dirname(path.dirname(p));
        const parentModule = parentModuleDir === "."
          ? null
          : parentModuleDir.replace(/\/$/, "").replace(/\//g, "::");
        yield {
          kind: "module",
          module: parentModule,
          name: module,
          docDir,
        };
      } else {
        const m = /([^.]+)\.([^.]+)\.html$/.exec(entry.name);
        if (m != null) {
          const kind = m[1];
          const module = path.dirname(p).replace(/\/$/, "").replace(
            /\//g,
            "::",
          );
          const name = m[2];
          yield { kind: kind as ItemKind, module, name, docDir };
        }
      }
    }
  }
}

const cache: Record<string, DocItem[]> = {};

async function* genCachedAllDocItemList(
  p: string,
): AsyncIterableIterator<DocItem> {
  const docDirs = await findDocDirs(p);
  for (const dir of docDirs) {
    if (dir in cache) {
      for (const item of cache[dir]) {
        yield item;
      }
    } else {
      cache[dir] = [];
      for await (const item of getDocItems(dir)) {
        cache[dir].push(item);
        yield item;
      }
    }
  }
}

type ActionData = {
  kind: ItemKind;
  module: string | null;
  name: string;
  url: string;
};

type Params = Record<string, never>;

function getDocItemFilePath(a: DocItem): string {
  let filePath = a.docDir;
  if (a.module != null) {
    filePath = path.join(filePath, ...a.module.split("::"));
  }
  if (a.kind === "module") {
    filePath = path.join(filePath, a.name, "index.html");
  } else {
    filePath = path.join(filePath, `${a.kind}.${a.name}.html`);
  }
  return filePath;
}

function docItemToDduItem(a: DocItem): Item<ActionData> {
  const module = a.module != null ? `${a.module}::` : "";
  const kindWidth = ITEM_KINDS.map((s) => s.length).reduce((a, c) =>
    Math.max(a, c)
  );
  const padding = " ".repeat(Math.max(0, kindWidth - a.kind.length));
  return {
    word: a.name,
    display: `${a.kind}${padding} ${module}${a.name}`,
    action: {
      kind: a.kind,
      module: a.module,
      name: a.name,
      url: `file://${getDocItemFilePath(a)}`,
    },
  };
}

async function* convertdocItems(
  itr: AsyncIterableIterator<DocItem>,
): AsyncIterableIterator<Item<ActionData>[]> {
  const BUFFER_SIZE = 1024;
  const buf = [];
  for await (const a of itr) {
    if (buf.length >= BUFFER_SIZE) {
      yield buf;
      buf.splice(0, buf.length);
    }
    buf.push(docItemToDduItem(a));
  }
  if (buf.length > 0) {
    yield buf;
  }
}

export class Source extends BaseSource<Params> {
  kind = "url";

  gather(args: {
    denops: Denops;
    context: Context;
    sourceParams: Params;
  }): ReadableStream<Item<ActionData>[]> {
    let items: AsyncIterator<Item<ActionData>[]> | null = null;
    return new ReadableStream({
      async start(_controller) {
        const bufnr = args.context.bufNr;
        const bufName = await fn.bufname(args.denops, bufnr);
        const cwd = await fn.getcwd(args.denops) as string;
        const bufPath = path.join(cwd, bufName);
        const docItems = genCachedAllDocItemList(bufPath);
        items = convertdocItems(docItems);
      },
      async pull(controller) {
        if (items == null) throw new Error("uninitialized items iterator");
        const { value, done } = await items.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
    });
  }

  params(): Params {
    return {};
  }
}
