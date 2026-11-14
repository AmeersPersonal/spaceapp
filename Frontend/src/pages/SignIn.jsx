import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const navigate = useNavigate()

  const handleSubmit = (e) => {
    e.preventDefault()
    // TODO: call backend auth endpoint
    console.log('Sign in', { email })
    navigate('/')
  }

  return (
    <section className="page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>Sign In</h1>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button type="submit" className="button">Sign In</button>
        <p>
          Don't have an account? <Link to="/signup">Sign up</Link>
        </p>
      </form>
    </section>
  )
}

export default SignIn
