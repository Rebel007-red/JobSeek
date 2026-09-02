// Debug LinkedIn API locally
const hdrs = {
  'Accept': 'application/json, text/javascript, */*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
};

try {
  console.log('🔍 Testing LinkedIn Jobs API...\n');
  
  const r = await fetch('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting?keywords=pyspark&location=&start=0&count=10', 
    { headers: hdrs, signal: AbortSignal.timeout(8000) });
  
  console.log('Status:', r.status);
  console.log('Content-Type:', r.headers.get('content-type'));
  
  const txt = await r.text();
  console.log('\n📊 Response Stats:');
  console.log('  - Length:', txt.length, 'bytes');
  console.log('  - Is HTML?', txt.includes('<'));
  console.log('  - Is JSON?', txt.startsWith('{') || txt.startsWith('['));
  console.log('  - Contains "data"?', txt.includes('data'));
  console.log('  - Contains jobs?', txt.includes('jobPostingId'));
  
  console.log('\n📋 First 1000 chars:');
  console.log(txt.slice(0, 1000));
  
  // Try to parse as JSON
  if (txt.startsWith('{') || txt.startsWith('[')) {
    const json = JSON.parse(txt);
    console.log('\n✅ Valid JSON! Structure:');
    console.log(JSON.stringify(json, null, 2).slice(0, 1500));
  }
  
} catch(e) {
  console.error('❌ Error:', e.message);
}
