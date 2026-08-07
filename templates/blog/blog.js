(() => {
  const posts = Array.isArray(window.blogPosts) ? window.blogPosts : []
  const postBySlug = new Map(posts.map((post) => [post.slug, post]))

  const formatDate = (date) =>
    new Intl.DateTimeFormat('en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(`${date}T12:00:00`))

  const metadata = (post) => `
    <div class="post-meta">
      <time datetime="${post.date}">${formatDate(post.date)}</time>
      <span aria-hidden="true">·</span>
      <span>${post.readingTime}</span>
      ${post.tags?.[0] ? `<span aria-hidden="true">·</span><span>${post.tags[0]}</span>` : ''}
    </div>
  `

  const postRow = (post) => `
    <article class="post-row">
      <a class="post-row-content" href="post.html?slug=${encodeURIComponent(post.slug)}">
        ${metadata(post)}
        <h3>${post.title}</h3>
        <p>${post.description}</p>
      </a>
      <a class="read-link" href="post.html?slug=${encodeURIComponent(post.slug)}" aria-label="Read ${post.title}">Read <span aria-hidden="true">↗</span></a>
    </article>
  `

  const renderPostList = () => {
    const list = document.querySelector('#post-list')
    const count = document.querySelector('#post-count')
    if (!list) return

    if (count) count.textContent = `${posts.length} ${posts.length === 1 ? 'post' : 'posts'}`

    list.innerHTML = posts.length
      ? posts.map(postRow).join('')
      : '<p class="empty-state">No posts yet. Add one in posts.js.</p>'
  }

  const renderPost = () => {
    const container = document.querySelector('#post')
    if (!container) return

    const slug = new URLSearchParams(window.location.search).get('slug')
    const post = slug ? postBySlug.get(slug) : undefined

    if (!post) {
      document.title = 'Post not found · Blog'
      container.innerHTML = `
        <div class="empty-state">
          <h1>Post not found</h1>
          <p>That note may have moved or does not exist yet.</p>
          <a class="text-link" href="index.html#posts">Back to all posts</a>
        </div>
      `
      return
    }

    document.title = `${post.title} · Blog`
    container.innerHTML = `
      <header class="post-header">
        ${metadata(post)}
        <h1>${post.title}</h1>
        <p class="post-description">${post.description}</p>
      </header>
      <div class="post-body">${post.content}</div>
    `
  }

  renderPostList()
  renderPost()
})()
