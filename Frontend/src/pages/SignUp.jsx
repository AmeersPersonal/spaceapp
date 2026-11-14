import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

function SignUp() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const handleSubmit = (e) => {
    e.preventDefault()
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    setError('')
    // TODO: call backend registration endpoint
    console.log('Sign up', { name, email })
    navigate('/signin')
  }

  return (
    <section className="page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>Sign Up</h1>
        <label>
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </label>
        <label>
          Confirm Password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="button">Create Account</button>
        <p>
          Already have an account? <Link to="/signin">Sign in</Link>
        </p>
      </form>
    </section>
  )
}

export default SignUp
