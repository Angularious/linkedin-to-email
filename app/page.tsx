import LinkedInForm from '@/components/LinkedInForm'

export default function Home() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        padding: '52px 20px 60px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '480px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '36px',
        }}
      >
        <h1
          style={{
            fontSize: '42px',
            color: '#111',
            textAlign: 'center',
            transform: 'rotate(-1deg)',
            lineHeight: 1.1,
            letterSpacing: '1px',
          }}
        >
          LinkedIn &rarr; Email
        </h1>

        <p
          style={{
            fontSize: '19px',
            color: '#555',
            textAlign: 'center',
            marginTop: '-20px',
            transform: 'rotate(0.5deg)',
          }}
        >
          paste a profile. get the email.
        </p>

        <LinkedInForm />

        <footer
          style={{
            fontSize: '17px',
            color: '#aaa',
            transform: 'rotate(-0.5deg)',
            textAlign: 'center',
          }}
        >
          powered by{' '}
          <a
            href="https://orthogonal.com?utm_source=linkedin-email-demo&utm_medium=referral&utm_content=footer"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: '#888',
              textDecoration: 'underline',
              textDecorationStyle: 'wavy',
              textUnderlineOffset: '3px',
            }}
          >
            orthogonal.com
          </a>
        </footer>
      </div>
    </main>
  )
}
