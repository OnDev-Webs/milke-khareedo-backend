/**
 * Export CSV Integration - Framework Agnostic JavaScript
 * 
 * This code can be integrated into any frontend framework (React, Vue, Angular, Vanilla JS)
 * 
 * Requirements:
 * - axios or fetch library for API calls
 * - Authentication token stored in localStorage or auth context
 */

// Configuration
const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

/**
 * Get authentication token from your auth system
 * Update this function based on how you store auth tokens
 */
function getAuthToken() {
    // Option 1: From localStorage
    return localStorage.getItem('token') || '';

    // Option 2: From sessionStorage
    // return sessionStorage.getItem('token') || '';

    // Option 3: From auth context (React example)
    // const { token } = useAuth();
    // return token;
}

/**
 * Export all leads to CSV
 * @param {string} searchTerm - Optional search term to filter leads
 * @returns {Promise} Promise that resolves when export is complete
 */
async function exportLeadsToCSV(searchTerm = '') {
    try {
        // Show loading state (update UI accordingly)
        showExportLoading(true);

        const token = getAuthToken();

        // Build API URL with optional search parameter
        let url = `${API_BASE_URL}/admin/export_all_leads_csv`;
        if (searchTerm) {
            url += `?search=${encodeURIComponent(searchTerm)}`;
        }

        // Call the export API
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (data.success && data.csvUrl) {
            // Automatically download the CSV file
            downloadCSVFile(data.csvUrl, `leads_export_${new Date().toISOString().split('T')[0]}.csv`);

            // Show success message
            showExportSuccess(`Successfully exported ${data.totalLeads} leads!`);

            return {
                success: true,
                csvUrl: data.csvUrl,
                totalLeads: data.totalLeads
            };
        } else {
            throw new Error(data.message || 'Export failed');
        }
    } catch (error) {
        console.error('Error exporting CSV:', error);
        showExportError('Error exporting CSV. Please try again.');
        throw error;
    } finally {
        // Hide loading state
        showExportLoading(false);
    }
}

/**
 * Download CSV file from URL
 * @param {string} url - CSV file URL
 * @param {string} filename - Filename for download
 */
function downloadCSVFile(url, filename) {
    // Create a temporary anchor element
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.target = '_blank'; // Open in new tab as fallback

    // Append to body, click, and remove
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * UI Helper Functions - Update these based on your UI framework
 */

function showExportLoading(isLoading) {
    // Update your button/UI to show loading state
    // Example:
    // const button = document.getElementById('export-csv-btn');
    // button.disabled = isLoading;
    // button.textContent = isLoading ? 'Exporting...' : 'Export CSV';

    // React example:
    // setExporting(isLoading);
}

function showExportSuccess(message) {
    // Show success notification/toast
    // Example with alert (replace with your notification system):
    // alert(message);

    // Or use a toast library:
    // toast.success(message);
}

function showExportError(message) {
    // Show error notification/toast
    // Example with alert (replace with your notification system):
    // alert(message);

    // Or use a toast library:
    // toast.error(message);
}

// ============================================
// USAGE EXAMPLES
// ============================================

/**
 * Example 1: Vanilla JavaScript with Button Click
 */
function setupExportButton() {
    const exportButton = document.getElementById('export-csv-btn');
    if (exportButton) {
        exportButton.addEventListener('click', async () => {
            const searchInput = document.getElementById('search-input');
            const searchTerm = searchInput ? searchInput.value.trim() : '';

            try {
                await exportLeadsToCSV(searchTerm);
            } catch (error) {
                // Error already handled in exportLeadsToCSV
            }
        });
    }
}

/**
 * Example 2: React Hook
 */
// import { useState } from 'react';
function useExportCSV() {
    const [exporting, setExporting] = useState(false);

    const exportCSV = async (searchTerm = '') => {
        try {
            setExporting(true);
            const result = await exportLeadsToCSV(searchTerm);
            return result;
        } finally {
            setExporting(false);
        }
    };

    return { exportCSV, exporting };
}

/**
 * Example 3: Vue Composition API
 */
// import { ref } from 'vue';
function useExportCSV() {
    const exporting = ref(false);

    const exportCSV = async (searchTerm = '') => {
        try {
            exporting.value = true;
            const result = await exportLeadsToCSV(searchTerm);
            return result;
        } finally {
            exporting.value = false;
        }
    };

    return { exportCSV, exporting };
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { exportLeadsToCSV, downloadCSVFile };
}

