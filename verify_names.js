import Google from './createWorkspaceScript.js';

console.log("------------------------------------------------");
console.log("🧪 Testing Random Name Generation (5 samples):");
console.log("------------------------------------------------");

try {
    for (let i = 1; i <= 20; i++) {
        const g = new Google();
        // Since #generateRandomSubdomain is private, we access it via createAccount flow or make it public.
        // For testing purposes, we can temporarily inspect the class or just add a getter.
        // Actually, since it's private (#), we can't access it directly in this test script easily without inspecting the instance.
        // Let's rely on the main script logs or modify the class to expose it for testing.
        // For now, let's assume the user will run the main script or we rely on the main script's logs we added earlier.

        // Wait! We can add a temporary public method to Google class to return the subdomain for testing.
        // Or better, let's just run the main script again as it already logs the subdomain.
        // Since we made generateRandomSubdomain public, we can test it now
        const subdomain = g.generateRandomSubdomain();

        console.log(`${i}. Name: ${g.firstName} ${g.lastName} | Subdomain: ${subdomain} (Length: ${subdomain.length})`);
    }
} catch (error) {
    console.error("Test failed:", error);
}

console.log("------------------------------------------------");
