import { Link } from 'react-router-dom'

function NotFound() {
  return (
    <section className="page">
      <h1>404</h1>

      <Link to="/" className="button">Back Home</Link>
    </section>
  )
}

export default NotFound
