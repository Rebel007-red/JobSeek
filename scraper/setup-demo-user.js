import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function createDemoUser() {
  try {
    // Create user with email/password
    const { data, error } = await supabase.auth.admin.createUser({
      email: 'demo@example.com',
      password: 'password',
      email_confirm: true,
    });

    if (error) {
      if (error.message.includes('already exists')) {
        console.log('✓ Demo user already exists');
      } else {
        throw error;
      }
    } else {
      console.log('✓ Demo user created:', data.user.id);
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

createDemoUser();
