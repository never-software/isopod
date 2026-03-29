import { useState, useEffect } from 'react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || `${window.location.protocol}//${window.location.hostname}:3000`

function App() {
  const [posts, setPosts] = useState([])
  const [error, setError] = useState(null)
  const [connected, setConnected] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [editing, setEditing] = useState(null)

  const fetchPosts = async () => {
    try {
      const res = await fetch(`${API_URL}/posts`)
      if (!res.ok) throw new Error(`${res.status}`)
      setPosts(await res.json())
      setConnected(true)
      setError(null)
    } catch (e) {
      setConnected(false)
      setError(`Cannot reach API at ${API_URL} — is the Rails server running?`)
    }
  }

  useEffect(() => { fetchPosts() }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!title.trim()) return

    const method = editing ? 'PATCH' : 'POST'
    const url = editing ? `${API_URL}/posts/${editing}` : `${API_URL}/posts`

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ post: { title, body } }),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      setTitle('')
      setBody('')
      setEditing(null)
      fetchPosts()
    } catch (e) {
      setError(`Failed to save post`)
    }
  }

  const handleDelete = async (id) => {
    try {
      await fetch(`${API_URL}/posts/${id}`, { method: 'DELETE' })
      fetchPosts()
    } catch (e) {
      setError(`Failed to delete post`)
    }
  }

  const startEdit = (post) => {
    setEditing(post.id)
    setTitle(post.title)
    setBody(post.body || '')
  }

  const cancelEdit = () => {
    setEditing(null)
    setTitle('')
    setBody('')
  }

  return (
    <>
      <h1>isopod example</h1>

      <div className="status">
        <span className={`dot ${connected ? 'connected' : ''}`} />
        {connected ? `Connected to API` : 'Disconnected'}
      </div>

      {error && <div className="error">{error}</div>}

      <form className="form" onSubmit={handleSubmit}>
        <input
          placeholder="Post title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          placeholder="Body (optional)"
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="actions">
          <button type="submit" className="btn-primary">
            {editing ? 'Update' : 'Create post'}
          </button>
          {editing && (
            <button type="button" className="btn-secondary" onClick={cancelEdit}>
              Cancel
            </button>
          )}
        </div>
      </form>

      <div className="posts">
        {posts.length === 0 && connected && (
          <div className="empty">No posts yet. Create one above.</div>
        )}
        {posts.map((post) => (
          <div key={post.id} className="post">
            <div className="post-content">
              <h3>{post.title}</h3>
              {post.body && <p>{post.body}</p>}
            </div>
            <div className="post-actions">
              <span className={`badge ${post.published ? 'published' : 'draft'}`}>
                {post.published ? 'published' : 'draft'}
              </span>
              <button className="btn-danger" onClick={() => startEdit(post)}>edit</button>
              <button className="btn-danger" onClick={() => handleDelete(post.id)}>delete</button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

export default App
