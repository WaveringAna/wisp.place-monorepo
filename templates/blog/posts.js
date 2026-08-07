// Add, remove, or generate posts here. Content is HTML so you can script and style it directly.
// Each post is rendered by blog.js on index.html and post.html.

window.blogPosts = [
  {
    slug: 'small-tools-last',
    title: 'The small tools I reach for last',
    description: 'A short list of utilities that quietly remove friction from everyday debugging.',
    date: '2025-04-18',
    tags: ['tools', 'workflow'],
    readingTime: '4 min read',
    content: `
      <p>Good tools do not ask for much attention. They sit close to the work, make one awkward step easier, and then get out of the way.</p>

      <p>This is a running list of small things I reach for when the obvious approach has stopped being useful. It is less a recommendation list than a reminder to keep the feedback loop short.</p>

      <h2>Start with the boring measurement</h2>
      <p>Before changing a system, I want one concrete observation: a trace, a request duration, a file count, or even a timestamp around the suspicious line.</p>

      <pre data-title="measure.js"><code>const startedAt = performance.now()
await doTheThing()
console.log("took", Math.round(performance.now() - startedAt), "ms")</code></pre>

      <p>The exact tool matters less than making the invisible visible. Once there is a number, the next decision tends to get smaller.</p>

      <h2>Keep the script nearby</h2>
      <p>If a command is useful more than once, it belongs in the repository. A tiny script with a clear name is often better than a paragraph in a team document.</p>
    `,
  },
  {
    slug: 'one-more-boundary',
    title: 'One more boundary than feels necessary',
    description: 'Why explicit boundaries make distributed systems easier to change later.',
    date: '2025-03-07',
    tags: ['systems', 'architecture'],
    readingTime: '6 min read',
    content: `
      <p>Most systems become difficult to change at the places where responsibilities were allowed to blur together.</p>

      <p>A boundary can be a function, a process, a queue, or a data format. It gives the next change somewhere specific to land. The cost is a little ceremony now; the benefit is fewer accidental dependencies later.</p>

      <blockquote>Make the boundary visible before you need to defend it.</blockquote>

      <h2>Boundaries are for people, too</h2>
      <p>Interfaces are not only for computers. A good boundary tells the next person what they can rely on, what they need to provide, and where to look when something goes wrong.</p>

      <ul>
        <li>Name the input and output.</li>
        <li>Keep failure close to the operation that caused it.</li>
        <li>Document the constraint that would surprise someone later.</li>
      </ul>
    `,
  },
  {
    slug: 'notes-on-shipping',
    title: 'Notes on shipping a first version',
    description: 'A lightweight checklist for getting a useful version out without polishing the wrong thing.',
    date: '2025-01-22',
    tags: ['process'],
    readingTime: '3 min read',
    content: `
      <p>The first version is not a smaller final version. It is an instrument for learning what deserves to become final.</p>

      <p>I try to make the smallest version that can create a real observation. That usually means fewer settings, fewer abstractions, and a path that is easy to explain out loud.</p>

      <h2>A practical first pass</h2>
      <ol>
        <li>Write down the one behavior that must work.</li>
        <li>Remove everything that does not help observe that behavior.</li>
        <li>Ship it to the smallest useful audience.</li>
        <li>Keep the notes from the first week.</li>
      </ol>

      <p>Those notes are usually more valuable than the original plan. They show where the rough edges actually are.</p>
    `,
  },
]
