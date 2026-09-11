/** Streaming parser shared by passthrough and non-streaming Chat Completions. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  try {
    while (true) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Upstream SSE frame exceeds limit')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          if (data.length) yield data.join('\n')
          data = []
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (done) break
    }
    if (buffer.trim() || data.length) throw new Error('Upstream SSE ended inside a frame')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class CompletionAccumulator {
  id = ''
  model = ''
  created = Math.floor(Date.now() / 1000)
  choices = new Map<number, any>()
  usage: any

  add(chunk: any): void {
    if (chunk.id) this.id = chunk.id
    if (chunk.model) this.model = chunk.model
    if (chunk.created) this.created = chunk.created
    if (chunk.usage) this.usage = chunk.usage
    for (const part of chunk.choices ?? []) {
      const choice = this.choices.get(part.index ?? 0) ?? {
        index: part.index ?? 0, message: { role: 'assistant', content: '' }, finish_reason: null,
        calls: new Map<number, any>(),
      }
      const delta = part.delta ?? part.message ?? {}
      if (typeof delta.content === 'string') choice.message.content += delta.content
      if (typeof delta.reasoning_content === 'string') choice.message.reasoning_content = (choice.message.reasoning_content ?? '') + delta.reasoning_content
      for (const call of delta.tool_calls ?? []) {
        const previous = choice.calls.get(call.index ?? 0) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (call.id) previous.id = call.id
        if (call.function?.name) previous.function.name += call.function.name
        if (call.function?.arguments) previous.function.arguments += call.function.arguments
        choice.calls.set(call.index ?? 0, previous)
      }
      if (part.finish_reason) choice.finish_reason = part.finish_reason
      this.choices.set(choice.index, choice)
    }
  }

  result(): any {
    return {
      id: this.id, object: 'chat.completion', created: this.created, model: this.model,
      choices: [...this.choices.values()].map(({ calls, ...choice }) => {
        if (calls.size) choice.message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)
        if (!choice.message.content && calls.size) choice.message.content = null
        return choice
      }),
      ...(this.usage ? { usage: this.usage } : {}),
    }
  }
}
