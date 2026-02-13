const mongoose = require("mongoose");
const crypto = require("crypto");

const connectivitySchema = new mongoose.Schema({
  name: String,
  latitude: Number,
  longitude: Number,
});

// Helper function to parse price string to number (in rupees)
const parsePriceToNumber = (priceStr) => {
  if (!priceStr) return 0;
  // If already a number, return it
  if (typeof priceStr === "number") return priceStr;
  // Parse string price
  let priceNum = parseFloat(priceStr.toString().replace(/[₹,\s]/g, "")) || 0;
  const priceStrLower = priceStr.toString().toLowerCase();
  if (priceStrLower.includes("lakh") || priceStrLower.includes("l")) {
    priceNum = priceNum * 100000;
  } else if (priceStrLower.includes("cr") || priceStrLower.includes("crore")) {
    priceNum = priceNum * 10000000;
  }
  return priceNum;
};

// Sub-configuration schema - each unitType can have multiple carpetArea/price combinations
const subConfigurationSchema = new mongoose.Schema(
  {
    carpetArea: {
      type: String,
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    availabilityStatus: {
      type: String,
      enum: ["Available", "Sold", "Reserved", "Ready"],
      default: "Available",
    },
    layoutPlanImages: [
      {
        type: String,
      },
    ],
  },
  { _id: true },
);

// Pre-save hook to convert price string to number
subConfigurationSchema.pre("save", function (next) {
  if (this.price && typeof this.price === "string") {
    this.price = parsePriceToNumber(this.price);
  }
  next();
});

// Configuration schema - each property can have multiple unitTypes
const configurationSchema = new mongoose.Schema(
  {
    unitType: {
      type: String,
      required: true,
    },
    subConfigurations: [subConfigurationSchema],
  },
  { _id: true },
);

const propertySchema = new mongoose.Schema(
  {
    projectId: {
      type: String,
      unique: true,
    },

    projectName: {
      type: String,
      required: true,
    },

    developer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Developer",
      required: true,
    },

    location: { type: String, required: true },
    latitude: { type: Number },
    longitude: { type: Number },
    totalUnits: {
      type: Number,
      default: 0,
    },

    projectSize: String,
    landParcel: String,
    possessionDate: Date,
    developerPrice: {
      type: Number,
      min: 0,
    },
    offerPrice: {
      type: Number,
      min: 0,
    },
    discountPercentage: { type: String, default: "00.00%" },
    minGroupMembers: Number,

    reraId: String,
    reraQrImage: String,

    possessionStatus: {
      type: String,
      enum: ["Ready To Move", "Under Construction"],
    },

    description: String,

    configurations: [configurationSchema],

    images: [
      {
        url: String,
        isCover: { type: Boolean, default: false },
        order: { type: Number, default: 1 },
      },
    ],

    highlights: [String],
    amenities: [String],

    connectivity: {
      type: Map,
      of: [connectivitySchema],
      default: {},
    },

    relationshipManager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    leadDistributionAgents: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    isStatus: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

// Helper function to parse price string to number (for developerPrice/offerPrice)
const parsePriceStringToNumber = (priceStr) => {
  if (!priceStr) return 0;
  if (typeof priceStr === "number") return priceStr;
  let priceNum = parseFloat(priceStr.toString().replace(/[₹,\s]/g, "")) || 0;
  const priceStrLower = priceStr.toString().toLowerCase();
  if (priceStrLower.includes("lakh") || priceStrLower.includes("l")) {
    priceNum = priceNum * 100000;
  } else if (priceStrLower.includes("cr") || priceStrLower.includes("crore")) {
    priceNum = priceNum * 10000000;
  }
  return priceNum;
};

propertySchema.pre("save", async function (next) {
  // Generate projectId if not exists
  if (!this.projectId) {
    const random = crypto.randomInt(10000, 99999);
    const formattedName = this.projectName.replace(/\s+/g, "");
    this.projectId = `#${formattedName}-${random}`;
  }

  // Calculate discount percentage if developerPrice and offerPrice exist
  if (this.developerPrice && this.offerPrice) {
    // Convert string prices to numbers if needed
    const devPrice =
      typeof this.developerPrice === "number"
        ? this.developerPrice
        : parsePriceStringToNumber(this.developerPrice);
    const offerPrice =
      typeof this.offerPrice === "number"
        ? this.offerPrice
        : parsePriceStringToNumber(this.offerPrice);

    // Update developerPrice and offerPrice to numbers if they were strings
    if (typeof this.developerPrice === "string") {
      this.developerPrice = devPrice;
    }
    if (typeof this.offerPrice === "string") {
      this.offerPrice = offerPrice;
    }

    if (devPrice > 0 && offerPrice > 0 && devPrice > offerPrice) {
      const discount = ((devPrice - offerPrice) / devPrice) * 100;
      this.discountPercentage = `${discount.toFixed(2)}%`;
    } else {
      this.discountPercentage = "00.00%";
    }
  } else {
    this.discountPercentage = "00.00%";
  }

  next();
});

module.exports = mongoose.model("Property", propertySchema);
