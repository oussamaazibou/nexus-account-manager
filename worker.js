// Worker script - runs in separate process for better isolation
// Import the Google class - need to use dynamic import for ES modules
(async () => {
    const module = await import('./createWorkspaceScript.js');
    const Google = module.default;
    
    // Get arguments from command line
    const args = process.argv.slice(2);
    const domain = args[0];
    const threadId = args[1];
    const proxyConfigStr = args[2];
    
    // Parse proxy config if provided
    let proxyConfig = null;
    if (proxyConfigStr && proxyConfigStr !== 'null') {
        try {
            proxyConfig = JSON.parse(proxyConfigStr);
        } catch (e) {
            proxyConfig = null;
        }
    }
    
    // Ensure cleanup on process exit
    let googleInstance = null;
    const cleanup = async () => {
        if (googleInstance) {
            try {
                await googleInstance.closeBrowser();
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    };
    
    process.once('exit', cleanup);
    process.once('SIGINT', async () => {
        await cleanup();
        process.exit(1);
    });
    process.once('SIGTERM', async () => {
        await cleanup();
        process.exit(1);
    });
    
    // Process single domain
    try {
        googleInstance = new Google(proxyConfig);
        await googleInstance.createAccount(domain, parseInt(threadId));
        
        // Ensure browser is closed before exiting
        await cleanup();
        
        // Success
        process.stdout.write(JSON.stringify({
            success: true,
            domain: domain
        }) + '\n');
        
        process.exit(0);
    } catch (error) {
        // Ensure browser is closed on error
        await cleanup();
        
        // Check if it's a rate limit error
        if (error.isRateLimit) {
            process.stderr.write(JSON.stringify({
                error: 'RATE_LIMIT',
                message: error.message
            }) + '\n');
            process.exit(2); // Exit code 2 for rate limit
        }
        
        const isAntiSpam = error.message && error.message.includes('anti-spam');
        
        // Failure
        process.stdout.write(JSON.stringify({
            success: false,
            domain: domain,
            error: error.message,
            isAntiSpam: isAntiSpam
        }) + '\n');
        
        process.exit(1);
    }
})();
