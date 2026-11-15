import { Link } from 'react-router-dom'
import { useAuth } from '../auth.jsx'
import { loginUrl, logoutUrl, signupUrl } from '../api.js'

// Accounts live in Auth0, not in this app: the button hands the browser to
// the API, which sends it to Auth0's hosted page and back here signed in.
// `mode` is 'signin' or 'signup'; SignUp.jsx reuses this component.
function SignIn({ mode = 'signin' }) {
  const { status, user, message } = useAuth()
  const signingUp = mode === 'signup'

  if (status === 'signed-in') {
    return (
      <section className="page">
        <div className="auth-form">
          <h1>You're signed in</h1>
          <p className="auth-note">{user.name || user.email}</p>
          <Link to="/events" className="button">Browse events</Link>
          <a href={logoutUrl} className="button secondary">Sign Out</a>
        </div>
      </section>
    )
  }

  return (
    <section className="page">
      <div className="auth-form">
        <h1>{signingUp ? 'Sign Up' : 'Sign In'}</h1>
        <p className="auth-note">
          {signingUp
            ? 'Create an account to ask the AI questions about an event.'
            : 'Sign in to ask the AI questions about an event.'}
        </p>
        {status === 'unavailable' && (
          <p className="error">Sign-in is unavailable right now: {message}</p>
        )}
        {status !== 'unavailable' && (
          <a href={signingUp ? signupUrl : loginUrl} className="button">
            {signingUp ? 'Create Account' : 'Continue to Sign In'}
          </a>
        )}
        <p>
          {signingUp ? (
            <>Already have an account? <Link to="/signin">Sign in</Link></>
          ) : (
            <>Don't have an account? <Link to="/signup">Sign up</Link></>
          )}
        </p>
      </div>
    </section>
  )
}

export default SignIn
