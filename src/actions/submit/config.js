/**
 * Maps formId (page path) to destination sheet path and JSON Schema for validation.
 */
export default {
  '/ca/fr_ca/corporate-information/media-center/media-relations/contacts': {
    path: '/ca/fr_ca/corporate-information/media-center/media-relations/contacts.json',
    schema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          enum: ['commercial', 'household', 'international'],
        },
        publication: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        reason: {
          type: 'string',
          enum: [
            'product-testing-request',
            'product-request',
            'consumer-contest-product-request',
            'new-product-information',
            'blending-trends-information',
            'recipe-request',
            'marketing-product-manager-interview',
            'president-ceo-interview',
            'other',
          ],
        },
        comments: { type: 'string' },
      },
      required: ['domain', 'firstName', 'lastName', 'email', 'phone', 'reason'],
      additionalProperties: false,
    },
  },

  '/ca/fr_ca/order-status': {
    path: '/ca/fr_ca/order-status.json',
    schema: {
      type: 'object',
      properties: {
        orderNumber: { type: 'string' },
      },
      required: ['orderNumber'],
      additionalProperties: false,
    },
  },

  '/ca/fr_ca/customer-service/contact-us': {
    path: '/ca/fr_ca/customer-service/contact-us.json',
    schema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        inquiryType: {
          type: 'string',
          enum: ['household', 'commercial'],
        },
        reason: {
          type: 'string',
          enum: [
            'check-order-status',
            'where-to-buy',
            'warranty-registration-help',
            'business-product-selection',
            'request-brochure',
            'recipe-help',
            'order-shipping-status',
            'order-tracking-request',
            'trade-in-program',
            'technical-question',
            'find-store-demo',
            'product-issue',
            'product-comparison-help',
            'become-retailer',
            'direct-purchase-help',
            'product-discount-program',
            'general-inquiry',
          ],
        },
        orderNumber: { type: 'string' },
        phone: { type: 'string' },
        communicationPreference: {
          type: 'string',
          enum: ['email', 'phone'],
        },
        serialNumber: { type: 'string' },
        comments: { type: 'string' },
      },
      required: ['firstName', 'lastName', 'email', 'inquiryType', 'reason'],
      additionalProperties: false,
    },
  },

  '/ca/fr_ca/customer-service/product-registration': {
    path: '/ca/fr_ca/customer-service/product-registration.json',
    schema: {
      type: 'object',
      properties: {
        serialNumber: { type: 'string' },
        country: { type: 'string' },
        intendedUse: {
          type: 'string',
          enum: ['home', 'business'],
        },
        purchasedFrom: {
          type: 'string',
          enum: [
            'amazon',
            'best-buy',
            'canadian-tire',
            'costco',
            'hudsons-bay',
            'other',
          ],
        },
        purchasedFromOther: { type: 'string' },
        purchaseDate: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        address: { type: 'string' },
        address2: { type: 'string' },
        city: { type: 'string' },
        province: {
          type: 'string',
          enum: [
            'AB', 'BC', 'MB', 'NB', 'NL', 'NT', 'NS',
            'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
          ],
        },
        postalCode: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        newsletterOptIn: { type: 'boolean' },
        termsAccepted: { type: 'boolean', const: true },
      },
      required: [
        'serialNumber', 'country', 'intendedUse', 'purchasedFrom',
        'purchaseDate', 'firstName', 'lastName', 'address', 'city',
        'province', 'postalCode', 'phone', 'email', 'termsAccepted',
      ],
      additionalProperties: false,
    },
  },

  '/ca/fr_ca/customer/account/login': {
    path: '/ca/fr_ca/customer/account/login.json',
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        password: { type: 'string' },
      },
      required: ['email', 'password'],
      additionalProperties: false,
    },
  },

  '/ca/fr_ca/corporate-wellness-program': {
    path: '/ca/fr_ca/corporate-wellness-program.json',
    schema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        companyName: { type: 'string' },
        jobTitle: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['firstName', 'lastName', 'companyName', 'jobTitle', 'phone', 'email'],
      additionalProperties: false,
    },
  },

  '/ca/fr_ca': {
    path: '/ca/fr_ca/newsletter.json',
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        phone: { type: 'string' },
        smsOptIn: { type: 'boolean' },
      },
      required: ['email'],
      additionalProperties: false,
    },
  },

  '/ca/fr_ca/customer/account/create': {
    path: '/ca/fr_ca/customer/account/create.json',
    schema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        confirmEmail: { type: 'string' },
        password: { type: 'string' },
        confirmPassword: { type: 'string' },
        postalCode: { type: 'string' },
        accountUsage: {
          type: 'string',
          enum: ['household', 'commercial'],
        },
        rewardsSignup: { type: 'boolean' },
        ownsVitamix: { type: 'boolean' },
        termsAccepted: { type: 'boolean', const: true },
      },
      required: [
        'firstName', 'lastName', 'email', 'confirmEmail',
        'password', 'confirmPassword', 'postalCode',
        'accountUsage', 'termsAccepted',
      ],
      additionalProperties: false,
    },
  },

  '/ca/fr_ca/customer/account/edit': {
    path: '/ca/fr_ca/customer/account/edit.json',
    schema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        postalCode: { type: 'string' },
        currentPassword: { type: 'string' },
        newPassword: { type: 'string' },
        confirmPassword: { type: 'string' },
        newsletterSubscription: { type: 'boolean' },
      },
      required: ['firstName', 'lastName', 'email'],
      additionalProperties: false,
    },
  },

  '/ca/fr_ca/customer/address': {
    path: '/ca/fr_ca/customer/address.json',
    schema: {
      type: 'object',
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        address: { type: 'string' },
        address2: { type: 'string' },
        city: { type: 'string' },
        province: {
          type: 'string',
          enum: [
            'AB', 'BC', 'MB', 'NB', 'NL', 'NT', 'NS',
            'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
          ],
        },
        postalCode: { type: 'string' },
        country: { type: 'string' },
        phone: { type: 'string' },
        defaultBilling: { type: 'boolean' },
        defaultShipping: { type: 'boolean' },
      },
      required: ['firstName', 'lastName', 'address', 'city', 'province', 'postalCode', 'country', 'phone'],
      additionalProperties: false,
    },
  },
};
