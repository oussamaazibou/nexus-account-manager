// API Base URL
const API_BASE = 'http://localhost:3000/api';

// State
let currentTemplate = 'education';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initFileUpload();
    initButtons();
    checkWorkerStatus();
    updateStats();

    // Auto-refresh stats every 5 seconds
    setInterval(updateStats, 5000);
});

// Tab System
function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetTab = tab.dataset.tab;

            // Update active tab
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Update active content
            tabContents.forEach(content => {
                content.classList.remove('active');
                if (content.id === `${targetTab}-tab`) {
                    content.classList.add('active');
                }
            });

            // Refresh monitor if switching to monitor tab
            if (targetTab === 'monitor') {
                loadJobs();
            }
        });
    });
}

// File Upload
function initFileUpload() {
    const fileInput = document.getElementById('accounts-file');
    const fileName = document.getElementById('file-name');

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            fileName.textContent = file.name;

            // Read file content
            const reader = new FileReader();
            reader.onload = (event) => {
                document.getElementById('accounts-textarea').value = event.target.result;
            };
            reader.readAsText(file);
        } else {
            fileName.textContent = 'No file chosen';
        }
    });
}

// Buttons
function initButtons() {
    document.getElementById('start-btn').addEventListener('click', startProcessing);
    document.getElementById('clear-btn').addEventListener('click', clearForm);
    document.getElementById('refresh-btn').addEventListener('click', loadJobs);
}

// Start Processing
async function startProcessing() {
    const textarea = document.getElementById('accounts-textarea');
    const accounts = textarea.value.trim();

    if (!accounts) {
        showNotification('Please enter or upload accounts', 'error');
        return;
    }

    const btn = document.getElementById('start-btn');
    btn.disabled = true;
    btn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" class="spin">
            <circle cx="12" cy="12" r="10" stroke-width="2"/>
            <path d="M12 2a10 10 0 0 1 10 10" stroke-width="2" stroke-linecap="round"/>
        </svg>
        Processing...
    `;

    try {
        // Parse accounts
        const lines = accounts.split('\n').filter(line => line.trim());
        let processed = 0;

        for (const line of lines) {
            const [email, password] = line.split(':').map(s => s.trim());

            if (!email || !password) {
                console.warn('Invalid line:', line);
                continue;
            }

            // Extract domain and create project ID
            const domain = email.split('@')[1];
            const domainPrefix = domain.split('.')[0].replace(/[^a-z0-9]/gi, '-').toLowerCase().substring(0, 12);
            const projectId = `${domainPrefix}-${Date.now().toString().slice(-6)}-${Math.random().toString(36).substr(2, 3)}`.substring(0, 30).replace(/-+$/, '');

            // Enqueue job
            const response = await fetch(`${API_BASE}/jobs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId,
                    userEmail: email,
                    userPassword: password,
                    saName: 'automation-sa',
                    template: currentTemplate
                })
            });

            if (response.ok) {
                processed++;
            }
        }

        showNotification(`Successfully queued ${processed} job(s)`, 'success');
        clearForm();
        updateStats();

        // Switch to monitor tab
        document.querySelector('[data-tab="monitor"]').click();

    } catch (error) {
        console.error('Error:', error);
        showNotification('Failed to start processing: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <polygon points="5 3 19 12 5 21 5 3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Start Processing
        `;
    }
}

// Clear Form
function clearForm() {
    document.getElementById('accounts-textarea').value = '';
    document.getElementById('accounts-file').value = '';
    document.getElementById('file-name').textContent = 'No file chosen';
}

// Apply Template
window.applyTemplate = function (template) {
    currentTemplate = template;
    showNotification(`Applied ${template} template`, 'success');

    // Switch to create tab
    document.querySelector('[data-tab="create"]').click();
}

// Check Worker Status
async function checkWorkerStatus() {
    try {
        const response = await fetch(`${API_BASE}/worker/status`);
        const data = await response.json();

        const statusEl = document.getElementById('worker-status');
        if (data.running) {
            statusEl.textContent = 'Worker: Running';
            statusEl.previousElementSibling.style.background = 'var(--success)';
        } else {
            statusEl.textContent = 'Worker: Stopped';
            statusEl.previousElementSibling.style.background = 'var(--danger)';
        }
    } catch (error) {
        const statusEl = document.getElementById('worker-status');
        statusEl.textContent = 'Worker: Unknown';
        statusEl.previousElementSibling.style.background = 'var(--warning)';
    }
}

// Update Stats
async function updateStats() {
    try {
        const response = await fetch(`${API_BASE}/stats`);
        const stats = await response.json();

        document.getElementById('total-jobs').textContent = stats.total || 0;
        document.getElementById('processing-jobs').textContent = stats.processing || 0;
        document.getElementById('completed-jobs').textContent = stats.completed || 0;
        document.getElementById('failed-jobs').textContent = stats.failed || 0;
    } catch (error) {
        console.error('Failed to update stats:', error);
    }
}

// Load Jobs
async function loadJobs() {
    const jobsList = document.getElementById('jobs-list');

    try {
        const response = await fetch(`${API_BASE}/jobs`);
        const jobs = await response.json();

        if (!jobs || jobs.length === 0) {
            jobsList.innerHTML = `
                <div class="empty-state">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" opacity="0.3">
                        <circle cx="12" cy="12" r="10" stroke-width="2"/>
                        <line x1="12" y1="8" x2="12" y2="12" stroke-width="2" stroke-linecap="round"/>
                        <line x1="12" y1="16" x2="12.01" y2="16" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                    <p>No jobs yet. Start processing to see jobs here.</p>
                </div>
            `;
            return;
        }

        jobsList.innerHTML = jobs.map(job => `
            <div class="job-item">
                <div class="job-header">
                    <span class="job-id">Job #${job.id}</span>
                    <span class="job-status status-${job.status}">${job.status}</span>
                </div>
                <div class="job-details">
                    <div>Email: ${job.data.userEmail}</div>
                    <div>Project: ${job.data.projectId}</div>
                    <div>Created: ${new Date(job.timestamp).toLocaleString()}</div>
                    ${job.progress ? `<div>Progress: ${job.progress}%</div>` : ''}
                </div>
            </div>
        `).join('');

    } catch (error) {
        console.error('Failed to load jobs:', error);
        jobsList.innerHTML = `
            <div class="empty-state">
                <p style="color: var(--danger);">Failed to load jobs. Make sure the API server is running.</p>
            </div>
        `;
    }
}

// Notification System
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.style.cssText = `
        position: fixed;
        top: 2rem;
        right: 2rem;
        padding: 1rem 1.5rem;
        background: ${type === 'success' ? 'var(--success)' : type === 'error' ? 'var(--danger)' : 'var(--info)'};
        color: white;
        border-radius: var(--radius-sm);
        box-shadow: 0 4px 12px var(--shadow);
        z-index: 1000;
        animation: slideIn 0.3s ease;
    `;
    notification.textContent = message;

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Add animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(100%);
            opacity: 0;
        }
    }
    
    @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
    }
    
    .spin {
        animation: spin 1s linear infinite;
    }
`;
document.head.appendChild(style);
