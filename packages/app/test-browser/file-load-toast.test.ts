import { afterEach, describe, expect, test } from "bun:test"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client/promise"
import { Data } from "effect"
import { createRoot, createSignal } from "solid-js"
import { ServerScope } from "@/runtime/server/scope"
import { createFileModel } from "@/workspaces/files/model"

type WatcherEvent = Extract<OpenCodeEvent, { type: "filesystem.changed" }>

class TestFileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
  readonly path: string
  readonly message: string
}> {}

const notFoundError = (path: string) => new TestFileNotFoundError({ path, message: `File not found: ${path}` })

const cleanups: VoidFunction[] = []

afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
})

function setup(options?: {
  opened?: readonly string[]
  read?: (input: Parameters<OpenCodeClient["file"]["read"]>[0]) => ReturnType<OpenCodeClient["file"]["read"]>
}) {
  const [opened, setOpened] = createSignal<readonly string[]>(options?.opened ?? [])
  const listeners = new Set<(event: WatcherEvent) => void>()
  const errors: string[] = []

  const api: OpenCodeClient["file"] = {
    read: (input) => (options?.read ? options.read(input) : Promise.reject(notFoundError(input.path))),
    list: () => Promise.resolve({ data: [] }),
    find: () => Promise.resolve({ data: [] }),
    status: () => Promise.resolve({ data: [] }),
  }

  return createRoot((dispose) => {
    cleanups.push(dispose)

    const model = createFileModel({
      directory: () => "/workspace",
      sessionID: () => "ses_test",
      scope: ServerScope.local,
      api,
      onFilesystemChanged: (handler) => {
        listeners.add(handler)

        return () => listeners.delete(handler)
      },
      opened,
      t: (key, params) => (params && "path" in params ? `${key}:${String(params.path)}` : key),
      onLoadError: (message) => errors.push(message),
    })

    return {
      model,
      errors,
      setOpened,
      emit: (file: string, event: WatcherEvent["data"]["event"]) => {
        listeners.forEach((listener) =>
          listener({
            id: `evt_${file}`,
            created: 1,
            type: "filesystem.changed",
            data: { file, event },
          }),
        )
      },
    }
  })
}

describe("createFileModel load error toasts", () => {
  test("stays quiet when syncing a missing file for a restored or focused tab", async () => {
    const { model, errors } = setup({ opened: ["/tmp/stickers-list-dark.png"] })

    await model.load("/tmp/stickers-list-dark.png", { silent: true })

    expect(model.notFound("/tmp/stickers-list-dark.png")).toBe(true)
    expect(errors).toEqual([])
  })

  test("stays quiet when a missing file is already open in a file tab", async () => {
    const { model, errors } = setup({ opened: ["src/deleted.ts"] })

    await model.load("src/deleted.ts")

    expect(model.notFound("src/deleted.ts")).toBe(true)
    expect(errors).toEqual([])
  })

  test("stays quiet when watcher invalidation reloads a deleted open file", async () => {
    const { model, errors, emit } = setup({ opened: ["src/deleted.ts"] })

    await Bun.sleep(0)
    emit("src/deleted.ts", "unlink")
    await Bun.sleep(0)

    expect(model.notFound("src/deleted.ts")).toBe(true)
    expect(errors).toEqual([])
  })

  test("reports a load error when actively opening a missing file that is not open in a tab", async () => {
    const { model, errors } = setup({ opened: [] })

    await model.load("src/missing.ts", { force: true })

    expect(model.notFound("src/missing.ts")).toBe(true)
    expect(errors).toEqual(["File not found: src/missing.ts"])
  })

  test("upgrades an in-flight silent load when an explicit load joins and fails with a non-404 error", async () => {
    const deferred = Promise.withResolvers<Awaited<ReturnType<OpenCodeClient["file"]["read"]>>>()

    const { model, errors } = setup({
      opened: ["src/unreadable.ts"],
      read: () => deferred.promise,
    })

    const first = model.load("src/unreadable.ts", { silent: true })
    const second = model.load("src/unreadable.ts")
    deferred.reject(new Error("permission denied"))
    await Promise.all([first, second])

    expect(model.get("src/unreadable.ts")?.error).toContain("permission denied")
    expect(errors).toEqual(["permission denied"])
  })
})
